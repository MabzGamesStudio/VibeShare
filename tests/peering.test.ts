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

  it('syncs content with peers at the configured rates', async () => {
    // A knows B's content but lacks the bytes; the sync job pulls them.
    const { manifest } = await b.importBuffer(randomBytesOf(3072, 11), { name: 'sync.bin', mime: 'application/octet-stream' });
    a.store.adopt(JSON.parse(JSON.stringify(manifest)), 'operator');
    for (const chunk of manifest.chunks) assert.equal(a.store.hasChunk(chunk.id), false);

    // The operator sets how often a round runs and the share/receive rates.
    const cfg = await admin<{ sync: { sendRatePerMin: number; receiveRatePerMin: number; enabled: boolean } }>(a.url(), '/v1/admin/peers/sync/config', {
      method: 'POST',
      body: { enabled: true, intervalMs: 60000, sendRatePerMin: 100, receiveRatePerMin: 100 },
    });
    assert.equal(cfg.sync.enabled, true);
    assert.equal(cfg.sync.sendRatePerMin, 100);
    assert.equal(cfg.sync.receiveRatePerMin, 100);

    // A round now pulls the missing bytes from B.
    const round = await admin<{ received: number }>(a.url(), '/v1/admin/peers/sync', { method: 'POST', body: {} });
    assert.equal(round.received, manifest.chunks.length);
    for (const chunk of manifest.chunks) assert.equal(a.store.hasChunk(chunk.id), true);

    // The receive rate caps how much moves in one round.
    const { manifest: second } = await b.importBuffer(randomBytesOf(4096, 12), { name: 'sync2.bin', mime: 'application/octet-stream' });
    a.store.adopt(JSON.parse(JSON.stringify(second)), 'operator');
    await admin(a.url(), '/v1/admin/peers/sync/config', { method: 'POST', body: { receiveRatePerMin: 1 } });
    const capped = await admin<{ received: number }>(a.url(), '/v1/admin/peers/sync', { method: 'POST', body: {} });
    assert.ok(capped.received <= 1, `the receive rate caps the round (got ${capped.received})`);
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

  it('runs a continuous peer-search job and answers peers at its own pace', async () => {
    // The operator sets how often the job requests from peers and how often the node
    // responds to them.
    const job = await admin<{ peering: { job: { enabled: boolean; intervalMs: number }; respondIntervalMs: number } }>(
      a.url(),
      '/v1/admin/peers/job',
      { body: { enabled: true, intervalMs: 5000, adopt: true, limit: 10, respondIntervalMs: 0 } }
    );
    assert.equal(job.peering.job.enabled, true);
    assert.equal(job.peering.job.intervalMs, 5000);

    // With no throttle the node answers and records when it answered.
    await admin(b.url(), '/v1/admin/peers/discover', { body: { criteria: {} } });

    // Turn the respond interval up: the same peer asking again right away is turned away.
    await admin(a.url(), '/v1/admin/peers/job', { body: { respondIntervalMs: 3600_000 } });
    const throttled = await admin<{ results: { peer: string; items: unknown[]; error?: string }[] }>(b.url(), '/v1/admin/peers/discover', {
      body: { criteria: {} },
    });
    assert.ok(
      throttled.results.some((r) => /at most once every/.test(r.error ?? '')),
      'the node turned the too-frequent peer away'
    );

    // The job can run a round on demand and reports what it took from each peer.
    await admin(a.url(), '/v1/admin/peers/job', { body: { respondIntervalMs: 0 } });
    const round = await admin<{ results: { peer: string }[] }>(a.url(), '/v1/admin/peers/search', { method: 'POST', body: {} });
    assert.ok(Array.isArray(round.results));
  });

  it('lets a new node bootstrap into a wide, unclustered peer set', async () => {
    // Anyone can see a wide sample of who a node peers with, to bootstrap from.
    const directory = await admin<{ self: string; peers: string[] }>(a.url(), '/v1/peers/peers');
    assert.equal(directory.self, a.reference());
    assert.ok(directory.peers.includes(b.reference()));

    // A brand-new node with one bootstrap seed learns peers and keeps a small, wide set.
    const c = await startAlgorithm({ peering: { bootstrap: [a.reference()], maxPeers: 2 } });
    try {
      await admin(c.url(), '/v1/admin/peers/bootstrap', { method: 'POST', body: {} });
      const got = await admin<{ peers: { ref: string }[] }>(c.url(), '/v1/admin/peers');
      const refs = got.peers.map((peer) => peer.ref);
      assert.ok(refs.length >= 1 && refs.length <= 2, `keeps a small, wide set (got ${refs.length})`);
      assert.ok(refs.includes(a.reference()), 'learned the seed it bootstrapped from');
    } finally {
      await c.stop();
    }
  });
});