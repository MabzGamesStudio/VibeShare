// "Accept all content automatically without reviewing it": off, the review queues hold
// everything; on, the same arrivals are accepted at once through the same accept/apply
// paths — and the switch takes effect the moment the operator saves it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { admin, clientFor, startAlgorithm, tempDir } from '../helpers.js';

describe('automatic acceptance', () => {
  it('queues everything when off and accepts it the moment it is on', async () => {
    const { dir, cleanup } = tempDir();
    const node = await startAlgorithm({}, dir);
    try {
      await admin(node.url(), '/v1/admin/content', {
        method: 'PUT',
        body: { id: 'yt:auto01', title: 'First', format: 'image', rating: 'all', status: 'listed' },
      });
      const client = clientFor(node.url());

      // Off by default: submissions and corrections wait in their queues.
      const queued = await client.json<{ id: string; status: string }>('/v1/submissions', {
        body: { id: 'yt:queue1', title: 'First', format: 'image' },
      });
      assert.equal(queued.status, 'pending', 'a submission waits for review');
      const waiting = await client.json<{ status: string }>('/v1/suggestions', {
        body: { id: 'yt:auto01', kind: 'format', value: 'video' },
      });
      assert.equal(waiting.status, 'pending', 'a correction waits for review');

      // The operator turns it on — no restart needed.
      await admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { policy: { autoAccept: true } } });

      const accepted = await client.json<{ id: string; status: string }>('/v1/submissions', {
        body: { id: 'yt:queue2', title: 'Second', format: 'image' },
      });
      assert.equal(accepted.status, 'accepted', 'a submission is accepted at once');
      const applied = await client.json<{ status: string }>('/v1/suggestions', {
        body: { id: 'yt:auto01', kind: 'rating', value: '13+' },
      });
      assert.equal(applied.status, 'accepted', 'a correction is accepted at once');

      // …and the correction went through the existing apply path onto the entry.
      const view = (await (await fetch(`${node.url()}/v1/content/yt:auto01`)).json()) as { rating: string };
      assert.equal(view.rating, '13+', 'the correction was applied');

      // Turning it off puts the queueing back.
      await admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { policy: { autoAccept: false } } });
      const queuedAgain = await client.json<{ status: string }>('/v1/submissions', {
        body: { id: 'yt:queue3', title: 'Third', format: 'image' },
      });
      assert.equal(queuedAgain.status, 'pending', 'the queue holds again when the setting is off');
    } finally {
      await node.stop();
      cleanup();
    }
  });
});
