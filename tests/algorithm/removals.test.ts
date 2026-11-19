// Content removal requests on an algorithm node: the creator's own content is deleted
// at once (the entry, and any submission still pending with it); anyone else's ask is
// queued for the operator, who approves the deletion or rejects the request.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { generateIdentity } from '../../src/shared/crypto.js';
import type { RemovalOutcome, RemovalRequest, RemovalRequestView } from '../../src/shared/protocol.js';
import { admin, clientFor, startAlgorithm } from '../helpers.js';

type RemovalList = { items: RemovalRequestView[]; total: number };

describe('content removal requests', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());

  it('deletes the creator’s own content at once', async () => {
    const identity = generateIdentity();
    const creator = clientFor(url, 'identity', identity);
    await admin(url, '/v1/admin/content', {
      method: 'PUT',
      body: { id: 'yt:creator-video', title: 'Creator video', format: 'video', creatorId: identity.id },
    });
    const answer = await creator.json<RemovalOutcome>('/v1/removals', { body: { id: 'yt:creator-video', message: 'taking this down' } });
    assert.deepEqual(answer, { deleted: true });
    assert.equal(node.registry.get('yt:creator-video'), undefined);
    const list = await admin<RemovalList>(url, '/v1/admin/removals');
    assert.equal(list.items.some((item) => item.cid === 'yt:creator-video'), false);
  });

  it('deletes content the account submitted, even before review', async () => {
    const submitter = clientFor(url, 'identity');
    await submitter.json('/v1/submissions', { body: { id: 'yt:submitted-video', title: 'Submitted', format: 'video' } });
    const answer = await submitter.json<RemovalOutcome>('/v1/removals', { body: { id: 'yt:submitted-video' } });
    assert.deepEqual(answer, { deleted: true });
    // The pending submission went with it: accepting it cannot bring the content back.
    const pending = Object.values(node.contributions.data.submissions).filter((s) => s.contentId === 'yt:submitted-video' && s.status === 'pending');
    assert.equal(pending.length, 0);
  });

  it('queues a stranger’s request with its message and lists it for the operator', async () => {
    await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: 'yt:stranger-video', title: 'Stranger video', format: 'video', creatorId: 'someone-else' } });
    const stranger = clientFor(url, 'pseudonym');
    const answer = await stranger.json<RemovalOutcome>('/v1/removals', { body: { id: 'yt:stranger-video', message: 'this is my face' } });
    assert.ok('queued' in answer && answer.queued, JSON.stringify(answer));
    const request: RemovalRequest = (answer as { request: RemovalRequest }).request;
    assert.equal(request.status, 'pending');
    const list = await admin<RemovalList>(url, '/v1/admin/removals');
    const row = list.items.find((item) => item.id === request.id);
    assert.ok(row, 'the queued request shows on the delete review list');
    assert.equal(row.title, 'Stranger video');
    assert.equal(row.message, 'this is my face');
    assert.equal(row.account, request.account);
    assert.ok(node.registry.get('yt:stranger-video'), 'nothing is deleted before the verdict');
  });

  it('refuses a second request from the same account', async () => {
    const stranger = clientFor(url, 'pseudonym');
    await stranger.json('/v1/removals', { body: { id: 'yt:stranger-video' } });
    await assert.rejects(stranger.json('/v1/removals', { body: { id: 'yt:stranger-video' } }), /already has a removal request/);
  });

  it('errors on content the node does not know', async () => {
    await assert.rejects(clientFor(url, 'pseudonym').json('/v1/removals', { body: { id: 'yt:never-heard-of' } }), /does not know this content/);
  });

  it('rejecting dismisses the request and leaves the content alone', async () => {
    const stranger = clientFor(url, 'pseudonym');
    const answer = await stranger.json<RemovalOutcome>('/v1/removals', { body: { id: 'yt:stranger-video', message: 'again' } });
    const request = (answer as { request: RemovalRequest }).request;
    await admin(url, `/v1/admin/removals/${request.id}/reject`, { method: 'POST' });
    const list = await admin<RemovalList>(url, '/v1/admin/removals');
    assert.equal(list.items.some((item) => item.id === request.id), false);
    assert.ok(node.registry.get('yt:stranger-video'), 'rejecting deletes nothing');
  });

  it('approving deletes the content and every request about it', async () => {
    const stranger = clientFor(url, 'pseudonym');
    const other = clientFor(url, 'pseudonym');
    const first = (await stranger.json<RemovalOutcome>('/v1/removals', { body: { id: 'yt:stranger-video' } })) as { request: RemovalRequest };
    await other.json('/v1/removals', { body: { id: 'yt:stranger-video' } });
    await admin(url, `/v1/admin/removals/${first.request.id}/approve`, { method: 'POST' });
    assert.equal(node.registry.get('yt:stranger-video'), undefined, 'approve deletes the entry');
    const list = await admin<RemovalList>(url, '/v1/admin/removals');
    assert.equal(list.items.some((item) => item.cid === 'yt:stranger-video'), false, 'the other request about it is moot');
  });
});
