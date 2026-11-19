// Content removal requests on a provider: the uploader's own content is deleted at
// once (with its storage jobs and bytes); anyone else's ask is queued for the
// operator, who approves the deletion or rejects the request.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { buildManifestFromBuffer, contentIdOf, type Manifest } from '../../src/shared/content.js';
import type { RemovalOutcome, RemovalRequest, RemovalRequestView } from '../../src/shared/protocol.js';
import { admin, clientFor, randomBytesOf, startProvider } from '../helpers.js';

type Provider = Awaited<ReturnType<typeof startProvider>>;
type RemovalList = { items: RemovalRequestView[]; total: number };

/** Pushes content through the client upload API — the uploader is an account of its own. */
async function pushUpload(provider: Provider, name: string, data: Buffer) {
  const uploader = clientFor(provider.url(), 'identity');
  const manifest: Manifest = await buildManifestFromBuffer(data, { name, mime: 'application/octet-stream' });
  const cid = contentIdOf(manifest);
  await uploader.json('/v1/uploads', { body: { manifest } });
  let offset = 0;
  for (const chunk of manifest.chunks) {
    await uploader.fetch(`/v1/uploads/${cid}/chunks/${chunk.id}`, { method: 'PUT', raw: data.subarray(offset, offset + chunk.size) });
    offset += chunk.size;
  }
  await uploader.json(`/v1/uploads/${cid}/commit`, { method: 'POST' });
  return { uploader, cid };
}

describe('content removal requests on a provider', async () => {
  const provider = await startProvider();
  const url = provider.url();
  after(() => provider.stop());

  it('deletes the uploader’s own content at once', async () => {
    const { uploader, cid } = await pushUpload(provider, 'mine.bin', randomBytesOf(4000, 11));
    const answer = await uploader.json<RemovalOutcome>('/v1/removals', { body: { id: cid, message: 'my own upload' } });
    assert.deepEqual(answer, { deleted: true });
    assert.equal(provider.store.getContent(cid), undefined, 'the record is gone');
  });

  it('resolves a link id the node knows to its content', async () => {
    const { uploader, cid } = await pushUpload(provider, 'linked.bin', randomBytesOf(4000, 12));
    provider.store.updateDetails(cid, { sources: ['yt:linked-video'] });
    const answer = await uploader.json<RemovalOutcome>('/v1/removals', { body: { id: 'yt:linked-video' } });
    assert.deepEqual(answer, { deleted: true });
    assert.equal(provider.store.getContent(cid), undefined);
  });

  it('queues a stranger’s request with its message and lists it for the operator', async () => {
    const { cid } = await pushUpload(provider, 'stranger.bin', randomBytesOf(4000, 13));
    const stranger = clientFor(url, 'pseudonym');
    const answer = await stranger.json<RemovalOutcome>('/v1/removals', { body: { id: cid, message: 'this is my video' } });
    assert.ok('queued' in answer && answer.queued, JSON.stringify(answer));
    const request: RemovalRequest = (answer as { request: RemovalRequest }).request;
    const list = await admin<RemovalList>(url, '/v1/admin/removals');
    const row = list.items.find((item) => item.id === request.id);
    assert.ok(row, 'the queued request shows on the delete review list');
    assert.equal(row.cid, cid);
    assert.equal(row.message, 'this is my video');
    assert.ok(provider.store.getContent(cid), 'nothing is deleted before the verdict');
  });

  it('errors on content the node does not know', async () => {
    await assert.rejects(clientFor(url, 'pseudonym').json('/v1/removals', { body: { id: 'vs1never-heard-of' } }), /does not know this content/);
  });

  it('refuses a second request from the same account', async () => {
    const stranger = clientFor(url, 'pseudonym');
    const { cid } = await pushUpload(provider, 'twice.bin', randomBytesOf(4000, 14));
    await stranger.json('/v1/removals', { body: { id: cid } });
    await assert.rejects(stranger.json('/v1/removals', { body: { id: cid } }), /already has a removal request/);
    await admin(url, `/v1/admin/removals/${(await admin<RemovalList>(url, '/v1/admin/removals')).items.find((item) => item.cid === cid)!.id}/reject`, {
      method: 'POST',
    });
  });

  it('rejecting dismisses the request and leaves the content alone', async () => {
    const { cid } = await pushUpload(provider, 'keep.bin', randomBytesOf(4000, 15));
    const stranger = clientFor(url, 'pseudonym');
    const answer = await stranger.json<RemovalOutcome>('/v1/removals', { body: { id: cid } });
    const request = (answer as { request: RemovalRequest }).request;
    await admin(url, `/v1/admin/removals/${request.id}/reject`, { method: 'POST' });
    const list = await admin<RemovalList>(url, '/v1/admin/removals');
    assert.equal(list.items.some((item) => item.id === request.id), false);
    assert.ok(provider.store.getContent(cid), 'rejecting deletes nothing');
  });

  it('approving deletes the content with its jobs', async () => {
    const { cid } = await pushUpload(provider, 'doomed.bin', randomBytesOf(4000, 16));
    const stranger = clientFor(url, 'pseudonym');
    const answer = await stranger.json<RemovalOutcome>('/v1/removals', { body: { id: cid } });
    const request = (answer as { request: RemovalRequest }).request;
    await admin(url, `/v1/admin/removals/${request.id}/approve`, { method: 'POST' });
    assert.equal(provider.store.getContent(cid), undefined, 'approve deletes the content');
    const list = await admin<RemovalList>(url, '/v1/admin/removals');
    assert.equal(list.items.some((item) => item.cid === cid), false);
  });
});
