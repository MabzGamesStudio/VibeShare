// Content data: the free-form key/value pairs kept on an entry — carried by a
// submission and read back on the content, and replaced as a whole by the admin route.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { admin, clientFor, startAlgorithm, tempDir } from '../helpers.js';

describe('content data', () => {
  it('publishes with the content and reads back, and the admin route updates and removes pairs', async () => {
    const { dir, cleanup } = tempDir();
    const node = await startAlgorithm({}, dir);
    try {
      // Publishing path: a submission carries the pairs, the accepted entry keeps them.
      const client = clientFor(node.url());
      const submission = await client.json<{ id: string }>('/v1/submissions', {
        body: {
          id: 'yt:datatest01',
          title: 'Data test',
          format: 'image',
          data: { env: 'prod', note: 'from the publisher' },
        },
      });
      await admin(node.url(), `/v1/admin/submissions/${submission.id}/accept`, { body: {} });

      const first = await (await fetch(`${node.url()}/v1/content/yt:datatest01`)).json() as { data?: Record<string, string> };
      assert.deepEqual(first.data, { env: 'prod', note: 'from the publisher' });

      // The admin route replaces the whole map: a kept pair is updated, a missing one
      // is gone, a new one appears.
      const saved = await admin<{ data?: Record<string, string> }>(node.url(), `/v1/admin/content/yt:datatest01/data`, {
        body: { data: { env: 'staging', team: 'core' } },
      });
      assert.deepEqual(saved.data, { env: 'staging', team: 'core' });
      const second = await (await fetch(`${node.url()}/v1/content/yt:datatest01`)).json() as { data?: Record<string, string> };
      assert.deepEqual(second.data, { env: 'staging', team: 'core' }, 'the update is visible on the content');

      // An empty map clears them all.
      await admin(node.url(), `/v1/admin/content/yt:datatest01/data`, { body: { data: {} } });
      const third = await (await fetch(`${node.url()}/v1/content/yt:datatest01`)).json() as { data?: Record<string, string> };
      assert.equal(third.data, undefined, 'an empty map removes the pairs');
    } finally {
      await node.stop();
      cleanup();
    }
  });

  it('keeps values short and the pair count bounded', async () => {
    const { dir, cleanup } = tempDir();
    const node = await startAlgorithm({}, dir);
    try {
      const many: Record<string, string> = {};
      for (let i = 0; i < 300; i++) many[`key-${i}`] = `value-${i}`;
      await admin(node.url(), '/v1/admin/content/yt:datatest02/data', { body: { data: many } });
      const view = await (await fetch(`${node.url()}/v1/content/yt:datatest02`)).json() as { data?: Record<string, string> };
      assert.ok(view.data);
      assert.equal(Object.keys(view.data).length, 200, 'at most 200 pairs are kept');
      assert.ok(!('key-250' in view.data), 'the pairs beyond the cap are dropped');

      await admin(node.url(), '/v1/admin/content/yt:datatest02/data', {
        body: { data: { k: 'x'.repeat(2000), ['y'.repeat(200)]: '1' } },
      });
      const capped = await (await fetch(`${node.url()}/v1/content/yt:datatest02`)).json() as { data?: Record<string, string> };
      assert.equal(capped.data?.k.length, 1000, 'values are capped at 1000 characters');
      assert.equal(capped.data?.['y'.repeat(80)], '1', 'keys are capped at 80 characters');
    } finally {
      await node.stop();
      cleanup();
    }
  });
});
