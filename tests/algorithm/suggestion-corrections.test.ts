// Client corrections end to end: each correction kind the "Correct the metadata" form
// posts is queued as a suggestion, and what the operator accepts is what the entry
// becomes — title, description, thumbnail, content data and topics (add, modify and
// delete, the corrected map/list replacing the old). A correction needs no reason.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { admin, clientFor, startAlgorithm } from '../helpers.js';

const THUMB = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`;

interface CorrectedView {
  title: string;
  description?: string;
  topics: string[];
  data?: Record<string, string>;
  thumbnail?: string;
}

describe('correction suggestions', () => {
  it('applies every corrected field the operator accepts', async () => {
    const node = await startAlgorithm();
    try {
      await admin(node.url(), '/v1/admin/content', {
        method: 'PUT',
        body: { id: 'yt:corrected', title: 'Old title', format: 'image', rating: 'all', status: 'listed', topics: ['space'], data: { a: '1' } },
      });
      const client = clientFor(node.url());
      const correct = async (kind: string, value: string) => {
        // No reason anywhere: a correction speaks for itself.
        const queued = await client.json<{ id: string; status: string }>('/v1/suggestions', { body: { id: 'yt:corrected', kind, value } });
        assert.equal(queued.status, 'pending', `${kind} waits for the operator`);
        await admin(node.url(), `/v1/admin/suggestions/${queued.id}/accept`, { method: 'POST' });
        return (await (await fetch(`${node.url()}/v1/content/yt:corrected`)).json()) as CorrectedView;
      };

      let view = await correct('title', 'Better title');
      assert.equal(view.title, 'Better title');

      view = await correct('description', 'A proper description.');
      assert.equal(view.description, 'A proper description.');
      view = await correct('description', '');
      assert.equal(view.description, undefined, 'an empty value clears the field');

      view = await correct('thumbnail', THUMB);
      assert.ok(view.thumbnail, 'the thumbnail is stored');
      view = await correct('thumbnail', '');
      assert.ok(!view.thumbnail, 'an empty thumbnail removes it');

      // Content data: the corrected map replaces the old one (add, modify, delete).
      view = await correct('data', JSON.stringify({ b: 'two', c: 'three' }));
      assert.deepEqual(view.data, { b: 'two', c: 'three' });
      view = await correct('data', JSON.stringify({ b: 'TWO' }));
      assert.deepEqual(view.data, { b: 'TWO' });

      // Topics: the corrected list replaces the old one — additions and deletes alike.
      view = await correct('topics', JSON.stringify(['space', 'science']));
      assert.deepEqual(view.topics, ['space', 'science']);
      view = await correct('topics', JSON.stringify(['science']));
      assert.deepEqual(view.topics, ['science']);
    } finally {
      await node.stop();
    }
  });

  it('rejects malformed thumbnails, data and topics', async () => {
    const node = await startAlgorithm();
    try {
      await admin(node.url(), '/v1/admin/content', {
        method: 'PUT',
        body: { id: 'yt:picky', title: 'Picky', format: 'image', rating: 'all', status: 'listed' },
      });
      const client = clientFor(node.url());
      const suggest = (kind: string, value: string) => client.json('/v1/suggestions', { body: { id: 'yt:picky', kind, value } });

      await assert.rejects(() => suggest('thumbnail', 'https://example.com/x.png'), 'a link is not a thumbnail');
      await assert.rejects(
        () => suggest('thumbnail', `data:image/png;base64,${Buffer.alloc(201 * 1024).toString('base64')}`),
        'an oversized thumbnail is refused'
      );
      await assert.rejects(() => suggest('data', 'not json'), 'content data is a JSON map');
      await assert.rejects(() => suggest('data', JSON.stringify({ a: 1 })), 'content data values are strings');
      await assert.rejects(() => suggest('topics', JSON.stringify({ a: 1 })), 'topics are a JSON list');
    } finally {
      await node.stop();
    }
  });
});
