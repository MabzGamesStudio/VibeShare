import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContentItem, Page } from '../src/shared/protocol.js';
import { BloomFilter } from '../src/shared/bloom.js';
import { admin, clientFor, startAlgorithm } from './helpers.js';

describe('search suggests VibeShare-published content first', () => {
  it('puts matching published content at the front, seen or not', async () => {
    const node = await startAlgorithm();
    const url = node.url();
    try {
      const vid = `vs1${'e'.repeat(52)}`;
      await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: `${vid}~yt:pub1`, title: 'Aurora published', format: 'video', rating: 'all' } });
      await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: 'yt:aur1', title: 'Aurora from elsewhere', format: 'video', rating: 'all' } });

      const client = clientFor(url);
      const search = (body: Record<string, unknown>) => client.json<Page<ContentItem>>('/v1/search', { body, auth: false });

      const first = await search({ query: 'aurora' });
      assert.equal(first.items[0].id, `${vid}~yt:pub1`, 'the VibeShare-published match comes first');

      // Even once the reader has seen both, the published match is still suggested
      // (marked as seen) while the rest of the seen content steps aside.
      const seen = new BloomFilter(10_000);
      seen.add(`${vid}~yt:pub1`);
      seen.add('yt:aur1');
      const withSeen = await search({ query: 'aurora', bloom: seen.toJSON() });
      assert.ok(withSeen.items.some((item) => item.id === `${vid}~yt:pub1`), 'still suggested even though it was seen');
      assert.ok(withSeen.items[0].id === `${vid}~yt:pub1`, 'and still first');
      assert.ok(!withSeen.items.some((item) => item.id === 'yt:aur1'), 'the rest respects the seen filter');
    } finally {
      await node.stop();
    }
  });

  it('leads an explore page with published content too, no query needed', async () => {
    const node = await startAlgorithm();
    const url = node.url();
    try {
      const vid = `vs1${'f'.repeat(52)}`;
      await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: 'yt:other1', title: 'Found elsewhere', format: 'video', rating: 'all' } });
      await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: `${vid}~yt:pub2`, title: 'Published here', format: 'video', rating: 'all' } });

      const client = clientFor(url);
      const explore = await client.json<Page<ContentItem>>('/v1/search', { body: { query: '' }, auth: false });
      assert.equal(explore.items[0].id, `${vid}~yt:pub2`, 'exploring starts with what is published on VibeShare');

      // Seen or not: the lead of an explore page is the same.
      const seen = new BloomFilter(10_000);
      seen.addContent({ id: `${vid}~yt:pub2`, contentId: vid, link: 'yt:pub2' });
      const withSeen = await client.json<Page<ContentItem>>('/v1/search', { body: { query: '', bloom: seen.toJSON() }, auth: false });
      assert.equal(withSeen.items[0].id, `${vid}~yt:pub2`, 'even after the reader has seen it');
    } finally {
      await node.stop();
    }
  });
});