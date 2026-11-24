// Content warnings (tag suggestions) end to end: a client's `kind: 'tag'` correction is
// accepted, waits in the review queue first, and lands as a tag note on the entry — the
// same place the operator's own tag corrections land.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { admin, clientFor, startAlgorithm, tempDir } from '../helpers.js';

describe('tag suggestions', () => {
  it('takes a content warning through the review queue onto the entry', async () => {
    const { dir, cleanup } = tempDir();
    const node = await startAlgorithm({}, dir);
    try {
      await admin(node.url(), '/v1/admin/content', {
        method: 'PUT',
        body: { id: 'yt:warningme', title: 'Clip', format: 'video', rating: 'all', status: 'listed' },
      });
      const client = clientFor(node.url());
      // The client's content-warning flow: a tag suggestion carrying the warning text.
      const sent = await client.json<{ status: string; id: string }>('/v1/suggestions', {
        body: { id: 'yt:warningme', kind: 'tag', value: 'sexual content', reason: 'Content warning: sexual content' },
      });
      assert.equal(sent.status, 'pending', 'tag suggestions wait for review like the rest');

      // Review queue first…
      const review = await admin<{ suggestions: { id: string; kind: string; value: string }[] }>(node.url(), '/v1/admin/suggestions');
      const found = review.suggestions.find((s) => s.kind === 'tag' && s.value === 'sexual content');
      assert.ok(found, 'the warning is waiting in the review queue');

      // …and applying it keeps the tag on the entry, with the reason the client gave.
      await admin(node.url(), `/v1/admin/suggestions/${found!.id}/accept`, { body: {} });
      const view = (await (await fetch(`${node.url()}/v1/content/yt:warningme`)).json()) as {
        notes?: { kind: string; value: string; reason: string }[];
      };
      const note = view.notes?.find((one) => one.kind === 'tag' && one.value === 'sexual content');
      assert.ok(note, 'the tag is on the entry');
      assert.equal(note?.reason, 'Content warning: sexual content');

      // A plain tag suggestion (the "Add a tag" correction) works the same, reason or not.
      const plain = await client.json<{ id: string; status: string }>('/v1/suggestions', {
        body: { id: 'yt:warningme', kind: 'tag', value: 'jump-scares' },
      });
      assert.equal(plain.status, 'pending');
      assert.ok(plain.id);
    } finally {
      await node.stop();
      cleanup();
    }
  });
});
