// Downloadable content copies: a client points a provider at a download URL (with its
// cid) or a base URL; the provider pulls content from it and pays the client for every
// download whose bytes hash to the cid exactly. When the provider does not hold a cid it
// sends the link instead, and the client only processes data whose cid matches exactly.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { bytesCid, bytesMatchCid } from '../src/shared/content.js';
import { clientFor, randomBytesOf, startClient, startProvider, tempDir } from './helpers.js';

describe('downloadable content copies (URLs and base URLs)', async () => {
  // The client's own endpoint serving downloadable copies, at a single URL and at a base.
  const files = new Map<string, Buffer>();
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const key = path.startsWith('/base/') ? decodeURIComponent(path.slice(6)) : path.slice(1);
    const data = files.get(key);
    if (!data) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length) }).end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const provider = await startProvider({ contentUrls: { autoAccept: true, creditPerDownload: 5, maxUrlsPerClient: 1, maxBaseUrlsPerClient: 1 } });
  const url = provider.url();
  const client = clientFor(url, 'identity');
  after(async () => {
    await provider.stop();
    server.close();
  });

  it('pays the client for each download whose content matches the cid exactly', async () => {
    const data = randomBytesOf(2048, 3);
    const cid = bytesCid(data);
    files.set('clip.bin', data);
    files.set(cid, data);

    const before = (await client.json<{ account: { balance: number } }>('/v1/account')).account.balance;

    // A single content URL, with the cid whose bytes it serves.
    const submitted = await client.json<{ record: { id: string; status: string } }>('/v1/content-urls', {
      body: { cid, url: `${origin}/clip.bin` },
    });
    assert.equal(submitted.record.status, 'accepted', 'auto-accept is on');

    // Feature 7: pull the copy — download, check the cid exactly, keep it, pay the client.
    const fetched = await client.json<{ fetched: boolean; downloaded: boolean }>('/v1/content-urls/fetch', { body: { cid } });
    assert.equal(fetched.fetched, true);
    assert.equal(fetched.downloaded, true);
    const after = (await client.json<{ account: { balance: number } }>('/v1/account')).account.balance;
    assert.equal(after, before + 5, 'credited for the download');

    // The kept copy is served back.
    const bytes = Buffer.from(await (await fetch(`${url}/v1/downloads/${cid}`)).arrayBuffer());
    assert.ok(bytes.equals(data));
  });

  it('sends a link instead of the content, and the client only accepts an exact cid match', async () => {
    const data = randomBytesOf(1024, 7);
    const cid = bytesCid(data);
    files.set(cid, data);

    // A base URL: the provider can query any cid at the client's endpoint.
    await client.json('/v1/content-urls', { body: { baseUrl: `${origin}/base` } });

    // Feature 8: this node does not hold the cid, so it sends the link instead.
    const answer = await fetch(`${url}/v1/content/${cid}`);
    assert.equal(answer.status, 200);
    const body = (await answer.json()) as { missing?: boolean; links?: { cid: string; url: string }[] };
    assert.equal(body.missing, true);
    assert.ok(body.links && body.links.length > 0);
    assert.equal(body.links![0].cid, cid);

    // The client fetches the data from the link and processes it only if the cid matches.
    const bytes = new Uint8Array(await (await fetch(body.links![0].url)).arrayBuffer());
    assert.ok(bytesMatchCid(bytes, cid), 'the bytes hash to exactly this cid');
    const tampered = Buffer.from(bytes);
    tampered[0] ^= 0xff;
    assert.ok(!bytesMatchCid(tampered, cid), 'tampered bytes are not processed');
  });

  it('accepts data from a link only on an exact cid match, and says so clearly when it does not match', async () => {
    const { dir, cleanup } = tempDir();
    const { client: node, api } = await startClient(dir);
    try {
      const data = randomBytesOf(512, 31);
      const cid = bytesCid(data);
      files.set('good.bin', data);
      const tampered = Buffer.from(data);
      tampered[0] ^= 0xff;
      files.set('bad.bin', tampered);

      const good = await api<{ ok: boolean; size: number }>(`/api/content-link`, { method: 'POST', body: { url: `${origin}/good.bin`, cid } });
      assert.equal(good.ok, true, 'the exact bytes are accepted');
      assert.equal(good.size, data.length);

      const bad = await api<{ ok: boolean; error: string }>(`/api/content-link`, { method: 'POST', body: { url: `${origin}/bad.bin`, cid } });
      assert.equal(bad.ok, false, 'tampered bytes are refused');
      assert.equal(bad.error, 'The downloaded content from the node/link does not match the expected cid');
    } finally {
      await node.stop();
      cleanup();
    }
  });

  it('caps how many content URLs and base URLs a client may add', async () => {
    await assert.rejects(client.json('/v1/content-urls', { body: { baseUrl: `${origin}/base` } }), /at most 1 base URLs/);
    await assert.rejects(client.json('/v1/content-urls', { body: { cid: bytesCid(randomBytesOf(16, 9)), url: `${origin}/x` } }), /at most 1 content URLs/);
  });

  it('lets a client node offer links through its own local API', async () => {
    const { dir, cleanup } = tempDir();
    const { client: node, api } = await startClient(dir);
    try {
      await api('/api/nodes', { body: { text: provider.reference() } });
      const state = await api<{ nodes: { id: string; type: string }[] }>('/api/state');
      const pid = state.nodes.find((n) => n.type === 'provider')!.id;
      const data = randomBytesOf(512, 21);
      files.set('client.bin', data);
      const cid = bytesCid(data);
      const result = await api<{ results: { record: { status: string } }[] }>(`/api/nodes/${pid}/content-urls`, {
        method: 'POST',
        body: { items: [{ cid, url: `${origin}/client.bin` }] },
      });
      assert.equal(result.results[0].record.status, 'accepted', 'submitted one URL + cid through the client API');
      const mine = await api<{ items: { cid?: string }[] }>(`/api/nodes/${pid}/content-urls`);
      assert.ok(mine.items.some((i) => i.cid === cid), 'and it shows among the client’s links');
    } finally {
      await node.stop();
      cleanup();
    }
  });
});
