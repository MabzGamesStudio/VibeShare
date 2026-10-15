// Peering: content providers exchange content bytes (by their hash), and algorithm
// nodes exchange content metadata and discoveries (by criteria).
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { PeerEntry } from '../src/shared/protocol.js';
import { admin, clientFor, randomBytesOf, startAlgorithm, startProvider } from './helpers.js';

describe('content providers peering', async () => {
  const a = await startProvider({ name: 'Peer A' });
  const b = await startProvider({ name: 'Peer B' });
  after(async () => {
    await a.stop();
    await b.stop();
  });

  it('exchanges content bytes given their hash', async () => {
    await admin(a.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: b.reference(), send: true, receive: true }] } });
    await admin(b.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: a.reference(), send: true, receive: true }] } });
    const { cid, manifest } = await a.importBuffer(randomBytesOf(4096), { name: 'clip.bin', mime: 'application/octet-stream' });

    // A sends what it has to B, chunk by chunk, addressed by the hash of the bytes.
    const pushed = await admin<{ results: { peer: string; sent: number; skipped: number }[] }>(a.url(), '/v1/admin/peers/push', {
      body: { cid },
    });
    assert.equal(pushed.results[0].sent, manifest.chunks.length);
    for (const chunk of manifest.chunks) assert.equal(b.store.hasChunk(chunk.id), true);

    // Pushing again finds nothing new to send.
    const again = await admin<{ results: { sent: number; skipped: number }[] }>(a.url(), '/v1/admin/peers/push', { body: { cid } });
    assert.equal(again.results[0].sent, 0);
    assert.equal(again.results[0].skipped, manifest.chunks.length);
  });

  it('fetches missing content bytes from a peer', async () => {
    // B knows the manifest (e.g. from the catalog) but lost the bytes.
    const { cid, manifest } = await a.importBuffer(randomBytesOf(2048), { name: 'more.bin', mime: 'application/octet-stream' });
    b.store.adopt(JSON.parse(JSON.stringify(a.store.getManifest(cid)!)), 'operator');
    for (const chunk of manifest.chunks) assert.equal(b.store.hasChunk(chunk.id), false);
    const fetched = await admin<{ fetched: number; missing: number }>(b.url(), '/v1/admin/peers/fetch', { body: { cid } });
    assert.equal(fetched.fetched, manifest.chunks.length);
    assert.equal(fetched.missing, 0);
    for (const chunk of manifest.chunks) assert.equal(b.store.hasChunk(chunk.id), true);
  });

  it('only serves and accepts peers it configured', async () => {
    const stranger = clientFor(a.url());
    await assert.rejects(stranger.json('/v1/peers/has', { body: { ids: [] } }), /peer/);
    const { cid } = await a.importBuffer(randomBytesOf(1024), { name: 'third.bin', mime: 'application/octet-stream' });
    await admin(b.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [] } });
    const pushed = await admin<{ results: { error?: string }[] }>(a.url(), '/v1/admin/peers/push', { body: { cid } });
    assert.match(pushed.results[0].error ?? '', /peer|403|forbidden/i);
    await admin(b.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: a.reference(), send: true, receive: true }] } });
  });
});

describe('algorithm nodes peering', async () => {
  const a = await startAlgorithm({ name: 'Peer A' });
  const b = await startAlgorithm({ name: 'Peer B' });
  after(async () => {
    await a.stop();
    await b.stop();
  });

  it('shares metadata of a cid or a link, and discovers by criteria', async () => {
    await admin(a.url(), '/v1/admin/content', {
      method: 'PUT',
      body: {
        id: `vs1${'c'.repeat(52)}~yt:with-link`,
        title: 'Both ids',
        format: 'video',
        publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    });
    await admin(a.url(), '/v1/admin/content', {
      method: 'PUT',
      body: { id: 'yt:peer-video', title: 'Peer video', format: 'video', publishedAt: new Date().toISOString() },
    });
    // A knows some platform numbers of one of them.
    await clientFor(a.url()).json('/v1/claims', { body: { id: 'yt:peer-video', source: 'youtube', metrics: { views: 5000, likes: 20 } } });
    await admin(a.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: b.reference(), fetch: true, serve: true }] } });
    await admin(b.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: a.reference(), fetch: true, serve: true }] } });

    // Metadata by content id and by link.
    const byCid = await admin<{ results: { entry?: PeerEntry }[] }>(b.url(), '/v1/admin/peers/metadata', {
      body: { id: `vs1${'c'.repeat(52)}` },
    });
    assert.equal(byCid.results[0].entry?.title, 'Both ids');
    const byLink = await admin<{ results: { entry?: PeerEntry }[] }>(b.url(), '/v1/admin/peers/metadata', {
      body: { id: 'yt:with-link' },
    });
    assert.equal(byLink.results[0].entry?.title, 'Both ids');
    const unknown = await admin<{ results: { entry?: PeerEntry | null }[] }>(b.url(), '/v1/admin/peers/metadata', { body: { id: 'yt:nobody' } });
    assert.equal(unknown.results[0].entry ?? null, null);

    // Discover by platform and by what the content carries.
    const discover = (criteria: Record<string, unknown>) =>
      admin<{ results: { items: PeerEntry[] }[] }>(b.url(), '/v1/admin/peers/discover', { body: { criteria } });
    const youtube = await discover({ platform: 'youtube' });
    assert.deepEqual(youtube.results[0].items.map((item) => item.id), ['yt:peer-video']);
    const native = await discover({ platform: 'vibeshare' });
    assert.deepEqual(native.results[0].items.map((item) => item.title), ['Both ids']);
    const everything = await discover({});
    assert.equal(everything.results[0].items.length, 2);
    const withCid = await discover({ has: 'cid' });
    assert.deepEqual(withCid.results[0].items.map((item) => item.title), ['Both ids']);
    const withLink = await discover({ has: 'link' });
    assert.deepEqual(withLink.results[0].items.map((item) => item.title).sort(), ['Both ids', 'Peer video'].sort());
    const both = await discover({ has: 'both' });
    assert.deepEqual(both.results[0].items.map((item) => item.title), ['Both ids']);

    // By content metrics, and by the algorithm the peer runs over what matches.
    const popular = await discover({ metrics: [{ key: 'views', min: 1000 }], algorithm: 'popular' });
    assert.deepEqual(popular.results[0].items.map((item) => item.title), ['Peer video']);
    const newest = await discover({ algorithm: 'new', limit: 1 });
    assert.deepEqual(newest.results[0].items.map((item) => item.title), ['Peer video']);
    const filtered = await discover({ filters: { formats: ['music'] } });
    assert.equal(filtered.results[0].items.length, 0);

    // Adopting takes the peer's finds into the catalog as pending.
    await admin(b.url(), '/v1/admin/peers/discover', { body: { criteria: { algorithm: 'new', limit: 10 }, adopt: true } });
    const pending = await admin<{ items: { id: string; origin?: string }[] }>(b.url(), '/v1/admin/content?status=pending');
    assert.equal(pending.items.length, 2);
    assert.ok(pending.items.every((item) => item.origin === 'peer'));
    // The platform numbers came with it.
    const stats = pending.items.find((item) => item.id === 'yt:peer-video') as unknown as { platformStats?: Record<string, number> };
    assert.equal(stats.platformStats?.views, 5000);
  });

  it('only answers peers it configured', async () => {
    const stranger = clientFor(a.url());
    await assert.rejects(stranger.json('/v1/peers/discover', { body: { criteria: {} } }), /peer/);
  });
});