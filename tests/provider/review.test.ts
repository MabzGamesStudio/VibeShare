// The provider review queue: content pushed from outside (client uploads, peer pushes)
// stays pending — unlisted, unserved and jobless — until the operator accepts it;
// rejecting deletes it entirely. Operator imports are never queued.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { buildManifestFromBuffer, contentIdOf, type Manifest } from '../../src/shared/content.js';
import type { RemoteError } from '../../src/shared/node/http.js';
import { admin, clientFor, randomBytesOf, startAlgorithm, startProvider, waitFor } from '../helpers.js';

type Provider = Awaited<ReturnType<typeof startProvider>>;

/** Pushes content through the client upload API — the path that must queue. */
async function pushUpload(provider: Provider, name: string, data: Buffer, before?: (cid: string) => Promise<unknown>) {
  const uploader = clientFor(provider.url(), 'identity');
  const manifest: Manifest = await buildManifestFromBuffer(data, { name, mime: 'application/octet-stream' });
  const cid = contentIdOf(manifest);
  await before?.(cid);
  await uploader.json('/v1/uploads', { body: { manifest } });
  let offset = 0;
  for (const chunk of manifest.chunks) {
    await uploader.fetch(`/v1/uploads/${cid}/chunks/${chunk.id}`, { method: 'PUT', raw: data.subarray(offset, offset + chunk.size) });
    offset += chunk.size;
  }
  const done = await uploader.json<{ status: string }>(`/v1/uploads/${cid}/commit`, { method: 'POST' });
  return { uploader, cid, manifest, done };
}

const notFound = (error: RemoteError) => {
  assert.equal(error.status, 404);
  return true;
};

describe('the provider review queue', async () => {
  const provider = await startProvider();
  after(async () => {
    await provider.stop();
  });

  it('keeps a pushed upload in review until the operator accepts it', async () => {
    const { cid, manifest, done } = await pushUpload(provider, 'queued.bin', randomBytesOf(3000, 3));
    assert.equal(done.status, 'pending', 'the commit reports the review state');

    // Invisible: not in the catalog, not in the admin list, not in the public catalog.
    const list = await admin<{ items: { cid: string }[]; total: number }>(provider.url(), '/v1/admin/content?limit=50');
    assert.equal(list.items.some((item) => item.cid === cid), false);
    const catalog = await clientFor(provider.url()).json<{ items: { cid: string }[] }>('/v1/catalog');
    assert.equal(catalog.items.some((item) => item.cid === cid), false);
    const review = await admin<{ items: { cid: string; name: string }[]; total: number }>(provider.url(), '/v1/admin/content/review');
    assert.equal(review.items.some((item) => item.cid === cid), true);
    assert.equal(review.items.find((item) => item.cid === cid)?.name, 'queued.bin');

    // Unserved: manifests and chunks answer as if unknown (bare chunk ids included).
    const viewer = clientFor(provider.url());
    await assert.rejects(viewer.fetch(`/v1/content/${cid}`), notFound);
    await assert.rejects(viewer.fetch(`/v1/chunks/${manifest.chunks[0].id}?cid=${cid}`), notFound);
    await assert.rejects(viewer.fetch(`/v1/chunks/${manifest.chunks[0].id}`), notFound);
    assert.equal(provider.store.servesChunk(manifest.chunks[0].id), false);
    const has = await viewer.json<{ has: Record<string, boolean> }>('/v1/has', { body: { ids: [cid] } });
    assert.equal(has.has[cid], false, 'pending content is not advertised');

    // Jobless: nothing to store yet.
    assert.equal(provider.service.jobs().filter((job) => job.cid === cid).length, 0);
  });

  it('accepting a pending upload makes it visible, served and jobbed', async () => {
    const { cid, manifest } = await pushUpload(provider, 'accepted.bin', randomBytesOf(3000, 5));
    const accepted = await admin<{ record: { cid: string } }>(provider.url(), `/v1/admin/content/${cid}/accept`, { method: 'POST' });
    assert.equal(accepted.record.cid, cid);

    const viewer = clientFor(provider.url());
    const served = await viewer.json<Manifest>(`/v1/content/${cid}`);
    assert.equal(contentIdOf(served), cid);
    const chunk = await viewer.fetch(`/v1/chunks/${manifest.chunks[0].id}?cid=${cid}`);
    assert.equal(chunk.status, 200);
    const list = await admin<{ items: { cid: string }[] }>(provider.url(), '/v1/admin/content?limit=50');
    assert.equal(list.items.some((item) => item.cid === cid), true);
    const review = await admin<{ items: { cid: string }[]; total: number }>(provider.url(), '/v1/admin/content/review');
    assert.equal(review.items.some((item) => item.cid === cid), false, 'the queue drops what it accepts');
    // The normal autoJob/tier path opens the storage job the moment it is accepted.
    assert.equal(provider.service.jobs().filter((job) => job.cid === cid).length > 0, true);
  });

  it('rejecting a pending upload deletes it with its bytes', async () => {
    const { cid, manifest } = await pushUpload(provider, 'rejected.bin', randomBytesOf(3000, 7));
    const rejected = await admin<{ ok: boolean; reason?: string }>(provider.url(), `/v1/admin/content/${cid}/reject`, {
      method: 'POST',
      body: { reason: 'not ours to host' },
    });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.reason, 'not ours to host');

    assert.equal(provider.store.getContent(cid), undefined);
    assert.equal(provider.store.hasChunk(manifest.chunks[0].id), false, 'the bytes go with the content');
    assert.equal(provider.service.jobs().filter((job) => job.cid === cid).length, 0, 'no job may outlive the content');
    const viewer = clientFor(provider.url());
    await assert.rejects(viewer.fetch(`/v1/content/${cid}`), notFound);
    const review = await admin<{ items: { cid: string }[]; total: number }>(provider.url(), '/v1/admin/content/review');
    assert.equal(review.items.some((item) => item.cid === cid), false, 'the queue drops what it rejects');
  });

  it('accepts operator imports at once, and deleting content deletes its storage jobs', async () => {
    // Imports never queue…
    const { cid, manifest } = await provider.importBuffer(randomBytesOf(4000, 11), { name: 'imported.bin' });
    assert.equal(provider.store.isPending(cid), false);
    const viewer = clientFor(provider.url());
    const served = await viewer.json<Manifest>(`/v1/content/${cid}`);
    assert.equal(contentIdOf(served), cid);
    assert.equal(provider.service.jobs().filter((job) => job.cid === cid).length > 0, true, 'the import earned its storage job');

    // …and deleting content takes its storage jobs with it.
    await admin(provider.url(), `/v1/admin/content/${cid}`, { method: 'DELETE' });
    assert.equal(provider.service.jobs().filter((job) => job.cid === cid).length, 0, 'the storage jobs go with the content');
    assert.equal(provider.store.hasChunk(manifest.chunks[0].id), false);
  });
});

describe('the provider review queue with peers', async () => {
  const pusher = await startProvider({ name: 'Pusher' });
  const receiver = await startProvider({ name: 'Receiver' });
  after(async () => {
    await pusher.stop();
    await receiver.stop();
  });

  it('holds a peer push in review and does not advertise its bytes', async () => {
    await admin(receiver.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: pusher.reference(), send: true, receive: true }] } });
    const { cid, manifest } = await pusher.importBuffer(randomBytesOf(3000, 13), { name: 'pushed.bin' });
    const result = await pusher.pushItem(receiver.url(), cid);
    assert.equal(result.error, undefined);
    assert.equal(result.manifest, true);

    assert.equal(receiver.store.isPending(cid), true, 'a peer push waits for review like a client upload');
    const viewer = clientFor(receiver.url());
    await assert.rejects(viewer.fetch(`/v1/content/${cid}`), notFound);
    const asPeer = clientFor(receiver.url(), 'identity', pusher.identity);
    const has = await asPeer.json<{ has: Record<string, boolean> }>('/v1/peers/has', { body: { ids: [manifest.chunks[0].id] } });
    assert.equal(has.has[manifest.chunks[0].id], false, 'the pending bytes are not advertised to peers');

    // Accepting on the receiving node publishes it there.
    await admin(receiver.url(), `/v1/admin/content/${cid}/accept`, { method: 'POST' });
    const served = await viewer.json<Manifest>(`/v1/content/${cid}`);
    assert.equal(contentIdOf(served), cid);
  });
});

describe('a provider with the review queue turned off', async () => {
  const provider = await startProvider({ review: { enabled: false } });
  after(async () => {
    await provider.stop();
  });

  it('accepts pushed content at once', async () => {
    const { cid, manifest, done } = await pushUpload(provider, 'direct.bin', randomBytesOf(3000, 17));
    assert.equal(done.status, 'ready');
    const viewer = clientFor(provider.url());
    const served = await viewer.json<Manifest>(`/v1/content/${cid}`);
    assert.equal(contentIdOf(served), cid);
    assert.equal(provider.store.isPending(cid), false);
    assert.equal(provider.store.servesChunk(manifest.chunks[0].id), true);
  });
});

describe('trusted algorithm search nodes', async () => {
  const provider = await startProvider();
  const algorithm = await startAlgorithm({ name: 'Vetting search node' });
  after(async () => {
    await provider.stop();
    await algorithm.stop();
  });

  it('round-trips the trusted list and rejects provider references', async () => {
    const empty = await admin<{ refs: string[]; autoAccept: boolean; nodes: unknown[] }>(provider.url(), '/v1/admin/algorithms');
    assert.deepEqual(empty, { refs: [], autoAccept: true, nodes: [] });
    const saved = await admin<{ refs: string[]; autoAccept: boolean; nodes: { online: boolean; name?: string }[] }>(provider.url(), '/v1/admin/algorithms', {
      method: 'PUT',
      body: { refs: [algorithm.reference()], autoAccept: true },
    });
    assert.deepEqual(saved.refs, [algorithm.reference()]);
    assert.equal(saved.autoAccept, true);
    assert.equal(saved.nodes[0]?.online, true, 'the probe reaches the running node');
    assert.ok(saved.nodes[0]?.name, 'the probe reports the node’s name');
    await assert.rejects(
      admin(provider.url(), '/v1/admin/algorithms', { method: 'PUT', body: { refs: [provider.reference()] } }),
      /Not an algorithm/
    );
  });

  it('auto-accepts pushed content the trusted node already lists', async () => {
    const { cid, done } = await pushUpload(provider, 'vetted.bin', randomBytesOf(3000, 23), (id) =>
      admin(algorithm.url(), '/v1/admin/content/bulk', { body: { ids: [id], status: 'listed' } })
    );
    assert.equal(done.status, 'pending', 'the push response never waits for the check');
    await waitFor(() => provider.store.isPending(cid) === false);
    const viewer = clientFor(provider.url());
    const served = await viewer.json<Manifest>(`/v1/content/${cid}`);
    assert.equal(contentIdOf(served), cid, 'accepted content is served');
    const list = await admin<{ items: { cid: string }[] }>(provider.url(), '/v1/admin/content?limit=50');
    assert.equal(list.items.some((item) => item.cid === cid), true);
    assert.equal(provider.service.jobs().filter((job) => job.cid === cid).length > 0, true, 'the normal autoJob path ran');
    const review = await admin<{ items: { cid: string }[] }>(provider.url(), '/v1/admin/content/review');
    assert.equal(review.items.some((item) => item.cid === cid), false, 'the queue entry disappears');
  });

  it('picks up a listing that lands after the push', async () => {
    // The real publish order is upload first, submit to the algorithm nodes second —
    // so the listing lands after the push. Nothing checks at push time here (no trusted
    // nodes configured yet); the next look at the content must pick the listing up.
    await admin(provider.url(), '/v1/admin/algorithms', { method: 'PUT', body: { refs: [], autoAccept: true } });
    const { cid } = await pushUpload(provider, 'late.bin', randomBytesOf(3000, 43));
    assert.equal(provider.store.isPending(cid), true);
    await admin(algorithm.url(), '/v1/admin/content/bulk', { body: { ids: [cid], status: 'listed' } });
    await admin(provider.url(), '/v1/admin/algorithms', { method: 'PUT', body: { refs: [algorithm.reference()] } });

    await assert.rejects(clientFor(provider.url()).fetch(`/v1/content/${cid}`), notFound);
    await waitFor(() => provider.store.isPending(cid) === false);
    const served = await clientFor(provider.url()).json<Manifest>(`/v1/content/${cid}`);
    assert.equal(contentIdOf(served), cid, 'the next fetch is served');
  });

  it('never accepts on the word of an untrusted algorithm node', async () => {
    const untrusted = await startAlgorithm({ name: 'Untrusted node' });
    try {
      await admin(provider.url(), '/v1/admin/algorithms', { method: 'PUT', body: { refs: [algorithm.reference()], autoAccept: true } });
      const { cid } = await pushUpload(provider, 'stranger-listed.bin', randomBytesOf(3000, 47));
      // The untrusted node lists it at once — the trusted one never does.
      await admin(untrusted.url(), '/v1/admin/content/bulk', { body: { ids: [cid], status: 'listed' } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(provider.store.isPending(cid), true, 'the untrusted listing changes nothing');
      await admin(provider.url(), '/v1/admin/content/review/sync', { method: 'POST', body: {} });
      assert.equal(provider.store.isPending(cid), true, 'not even the sync accepts on an untrusted word');
    } finally {
      await untrusted.stop();
    }
  });

  it('leaves pushed content in review when auto-accept is off', async () => {
    await admin(provider.url(), '/v1/admin/algorithms', { method: 'PUT', body: { autoAccept: false } });
    const { cid } = await pushUpload(provider, 'manual.bin', randomBytesOf(3000, 29), (id) =>
      admin(algorithm.url(), '/v1/admin/content/bulk', { body: { ids: [id], status: 'listed' } })
    );
    // The lookup is local and fast: anything still pending after this beat stays pending.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(provider.store.isPending(cid), true, 'the listing alone decides nothing when the toggle is off');
    const review = await admin<{ items: { cid: string }[] }>(provider.url(), '/v1/admin/content/review');
    assert.equal(review.items.some((item) => item.cid === cid), true);
    await admin(provider.url(), '/v1/admin/algorithms', { method: 'PUT', body: { autoAccept: true } });
  });

  it('never accepts from an unreachable node, and never breaks the push', async () => {
    const gone = await startAlgorithm({ name: 'Gone' });
    await gone.stop();
    await admin(provider.url(), '/v1/admin/algorithms', { method: 'PUT', body: { refs: [gone.reference()] } });
    const { cid, done } = await pushUpload(provider, 'stranded.bin', randomBytesOf(3000, 31));
    assert.equal(done.status, 'pending', 'the push itself succeeds');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(provider.store.isPending(cid), true, 'a dead node vouches for nothing');
  });

  it('syncs the queue with the trusted nodes on demand', async () => {
    await admin(provider.url(), '/v1/admin/algorithms', { method: 'PUT', body: { refs: [algorithm.reference()], autoAccept: false } });
    const listed = await pushUpload(provider, 'sync-listed.bin', randomBytesOf(3000, 37));
    const unlisted = await pushUpload(provider, 'sync-unlisted.bin', randomBytesOf(3000, 41));
    await admin(algorithm.url(), '/v1/admin/content/bulk', { body: { ids: [listed.cid], status: 'listed' } });

    const result = await admin<{ checked: number; accepted: number; errors: number }>(provider.url(), '/v1/admin/content/review/sync', {
      method: 'POST',
      body: {},
    });
    assert.ok(result.checked >= 2, 'every queued content was checked');
    assert.ok(result.accepted >= 1, 'the listed content was accepted');
    assert.equal(result.errors, 0);
    assert.equal(provider.store.isPending(listed.cid), false, 'what the trusted node lists is accepted');
    assert.equal(provider.store.isPending(unlisted.cid), true, 'what nobody lists stays in review');
  });

  it('round-trips the automatic sync minutes and validates them', async () => {
    await admin(provider.url(), '/v1/admin/config', { method: 'PUT', body: { review: { enabled: true, syncMinutes: 5 } } });
    const saved = await admin<{ review: { enabled: boolean; syncMinutes: number } }>(provider.url(), '/v1/admin/config');
    assert.equal(saved.review.enabled, true);
    assert.equal(saved.review.syncMinutes, 5);
    await assert.rejects(
      admin(provider.url(), '/v1/admin/config', { method: 'PUT', body: { review: { enabled: true, syncMinutes: -1 } } }),
      /syncMinutes/
    );
    await admin(provider.url(), '/v1/admin/config', { method: 'PUT', body: { review: { enabled: true, syncMinutes: 0 } } });
  });
});

describe('the accept-all toggle', async () => {
  const provider = await startProvider();
  after(async () => {
    await provider.stop();
  });

  it('takes effect on the next push when flipped at runtime', async () => {
    // Off (the default): pushed content waits for review.
    const first = await pushUpload(provider, 'flipped-off.bin', randomBytesOf(3000, 53));
    assert.equal(first.done.status, 'pending');
    assert.equal(provider.store.isPending(first.cid), true);

    // The general-settings switch stores the queue as off (review.enabled: false).
    await admin(provider.url(), '/v1/admin/config', { method: 'PUT', body: { review: { enabled: false, syncMinutes: 0 } } });

    const second = await pushUpload(provider, 'flipped-on.bin', randomBytesOf(3000, 57));
    assert.equal(second.done.status, 'ready', 'the next push is accepted immediately');
    assert.equal(provider.store.isPending(second.cid), false);
    const viewer = clientFor(provider.url());
    const served = await viewer.json<Manifest>(`/v1/content/${second.cid}`);
    assert.equal(contentIdOf(served), second.cid, 'served to clients');
    const list = await admin<{ items: { cid: string }[] }>(provider.url(), '/v1/admin/content?limit=50');
    assert.equal(list.items.some((item) => item.cid === second.cid), true, 'straight into the catalog');
    assert.equal(provider.service.jobs().filter((job) => job.cid === second.cid).length > 0, true, 'with its storage job');

    // Flipped back on: the next push waits again — and the toggle never rescues what
    // is already queued.
    await admin(provider.url(), '/v1/admin/config', { method: 'PUT', body: { review: { enabled: true, syncMinutes: 0 } } });
    const third = await pushUpload(provider, 'flipped-back.bin', randomBytesOf(3000, 59));
    assert.equal(third.done.status, 'pending');
    assert.equal(provider.store.isPending(first.cid), true);
  });

  it('rejects a non-boolean value', async () => {
    await assert.rejects(
      admin(provider.url(), '/v1/admin/config', { method: 'PUT', body: { review: { enabled: 'yes', syncMinutes: 0 } } }),
      /review\.enabled/
    );
  });
});
