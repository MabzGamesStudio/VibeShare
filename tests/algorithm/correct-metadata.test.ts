// "Correct the metadata": the correction path behind the algorithm admin — title,
// description and topics through the content edit (with the registry keeping topic ids
// in step), content data through its own route, and a suggestion no longer needs a
// reason.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { admin, clientFor, startAlgorithm, tempDir } from '../helpers.js';

interface CorrectedView {
  title: string;
  description?: string;
  topics: string[];
  topicIds?: string[];
  notes?: { kind: string; value: string; reason: string }[];
  data?: Record<string, string>;
}

describe('correcting the metadata', () => {
  it('applies corrections through the admin routes and takes suggestions without a reason', async () => {
    const { dir, cleanup } = tempDir();
    const node = await startAlgorithm({}, dir);
    try {
      await admin(node.url(), '/v1/admin/content', {
        method: 'PUT',
        body: { id: 'yt:correctme', title: 'Old title', format: 'image', rating: 'all', status: 'listed' },
      });

      // Title, content description and topics (add/modify/delete) through the content
      // edit: the registry derives the topic ids alongside the names.
      const saved = await admin<{ title: string; topicIds?: string[] }>(node.url(), '/v1/admin/content', {
        method: 'PUT',
        body: {
          id: 'yt:correctme',
          title: 'New title',
          description: 'A proper description.',
          topics: ['science', 'space'],
          notes: [{ kind: 'correction', value: 'title', reason: 'it was a placeholder' }],
        },
      });
      assert.equal(saved.title, 'New title');
      assert.equal(saved.topicIds?.length, 2, 'the registry keeps topic ids with the names');

      const view = (await (await fetch(`${node.url()}/v1/content/yt:correctme`)).json()) as CorrectedView;
      assert.equal(view.title, 'New title');
      assert.equal(view.description, 'A proper description.');
      assert.deepEqual(view.topics, ['science', 'space']);
      assert.ok(view.notes?.some((note) => note.kind === 'correction' && note.reason === 'it was a placeholder'), 'the reason is kept');

      // Topics can shrink again (delete).
      await admin(node.url(), '/v1/admin/content', { method: 'PUT', body: { id: 'yt:correctme', topics: ['space'] } });
      const fewer = (await (await fetch(`${node.url()}/v1/content/yt:correctme`)).json()) as CorrectedView;
      assert.deepEqual(fewer.topics, ['space']);
      assert.equal(fewer.topicIds?.length, 1);

      // What a correction empties is cleared: no description, no topics, no creator.
      await admin(node.url(), '/v1/admin/content', {
        method: 'PUT',
        body: { id: 'yt:correctme', description: '', topics: [], creatorId: '' },
      });
      const cleared = (await (await fetch(`${node.url()}/v1/content/yt:correctme`)).json()) as CorrectedView & { creatorId?: string };
      assert.equal(cleared.description, undefined, 'an empty description removes it');
      assert.equal(cleared.topics?.length ?? 0, 0, 'an empty topic list removes every topic');
      assert.equal(cleared.topicIds?.length ?? 0, 0, '…and their ids');
      assert.equal(cleared.creatorId, undefined, 'an empty creator removes it');

      // Content data pairs through their own route.
      await admin(node.url(), '/v1/admin/content/yt:correctme/data', { body: { data: { env: 'prod' } } });
      const withData = (await (await fetch(`${node.url()}/v1/content/yt:correctme`)).json()) as CorrectedView;
      assert.deepEqual(withData.data, { env: 'prod' });

      // A correction suggestion speaks for itself: no reason required.
      const client = clientFor(node.url());
      const suggestion = await client.json<{ status: string }>('/v1/suggestions', {
        body: { id: 'yt:correctme', kind: 'topic', value: 'nature' },
      });
      assert.ok(suggestion.status, 'the suggestion went through without a reason');
    } finally {
      await node.stop();
      cleanup();
    }
  });
});
