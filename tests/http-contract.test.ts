// The two contracts the whole project shares: content-addressed reads are cacheable
// exactly to the extent they are immutable (ETag = the id, If-None-Match → 304), and
// every /api/* reply carries the local API's version marker.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { clientRoutes } from '../src/client/api.js';
import { API_VERSION } from '../src/shared/api-version.js';
import { randomBytesOf, startClient, startProvider, tempDir } from './helpers.js';

describe('http caching of content-addressed reads', async () => {
  const provider = await startProvider({ pricing: { perMiB: 0 } });
  after(async () => {
    await provider.stop();
  });

  it('tags manifests and chunks with their id and answers 304 to revalidations', async () => {
    const { cid, manifest } = await provider.importBuffer(randomBytesOf(2048, 3), { name: 'cache.bin' });

    // The manifest: the content id is its strong validator, and free reads may sit in
    // shared caches.
    const first = await fetch(`${provider.url()}/v1/content/${cid}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('etag'), `"${cid}"`);
    assert.equal(first.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const body = (await first.json()) as { name: string };
    assert.equal(body.name, 'cache.bin');

    // A revalidation gets 304 with no body instead of the manifest again.
    const again = await fetch(`${provider.url()}/v1/content/${cid}`, { headers: { 'if-none-match': `"${cid}"` } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), `"${cid}"`);
    assert.equal(await again.text(), '');

    // A stale validator still gets the whole body.
    const stale = await fetch(`${provider.url()}/v1/content/${cid}`, { headers: { 'if-none-match': '"something-else"' } });
    assert.equal(stale.status, 200);
    await stale.arrayBuffer();

    // Chunks are content-addressed the same way.
    const chunkId = manifest.chunks[0].id;
    const chunk = await fetch(`${provider.url()}/v1/chunks/${chunkId}`);
    assert.equal(chunk.status, 200);
    assert.equal(chunk.headers.get('etag'), `"${chunkId}"`);
    assert.equal(chunk.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    await chunk.arrayBuffer();
    const chunkAgain = await fetch(`${provider.url()}/v1/chunks/${chunkId}`, { headers: { 'if-none-match': `"${chunkId}"` } });
    assert.equal(chunkAgain.status, 304);
    assert.equal(await chunkAgain.text(), '');
  });
});

describe('the local api contract', async () => {
  const { dir, cleanup } = tempDir();
  const { client } = await startClient(dir);
  after(async () => {
    await client.stop();
    cleanup();
  });

  it('stamps every client route with the api version and answers /api/version', async () => {
    const token = { 'x-vs-token': client.token };

    const version = await fetch(`${client.url()}/api/version`, { headers: token });
    assert.equal(version.headers.get('x-vs-api'), String(API_VERSION));
    assert.deepEqual(await version.json(), { version: API_VERSION });

    // Every route of the local API answers with the marker — whatever the status, so
    // validation errors and404s are covered as well as the happy path. Handlers run
    // against harmless inputs (a missing id, an empty body).
    for (const route of clientRoutes({} as never)) {
      const path = route.path.replace(/:[a-zA-Z]+/g, 'missing');
      const response = await fetch(client.url() + path, {
        method: route.method,
        headers: { ...token, 'content-type': 'application/json' },
        body: route.method === 'GET' || route.method === 'DELETE' ? undefined : '{}',
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.headers.get('x-vs-api'), String(API_VERSION), `${route.method} ${route.path} carries the marker`);
      // Some routes answer with a stream (the events feed): stop reading, keep the check.
      await response.body?.cancel();
    }

    // Hand-written replies (the events stream) carry the marker too.
    const events = await fetch(`${client.url()}/api/events`, { headers: token, signal: AbortSignal.timeout(10_000) });
    assert.equal(events.headers.get('x-vs-api'), String(API_VERSION));
    await events.body?.cancel();
  });
});
