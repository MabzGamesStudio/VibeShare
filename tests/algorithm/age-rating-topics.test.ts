// The catalog carries age ratings as topics: editing an entry's topics through the
// content edit keeps the filing (topic ids) in step with the names, and exactly one
// age-rating topic lives on an entry at a time. The admin modal derives the legacy
// rating from the topic client-side; here we pin the storage contract it relies on.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UNKNOWN_AGE_RATING_TOPIC, ageRatingTopic, legacyRatingOf, withAgeRatingTopic } from '../../src/shared/age-rating.js';
import { topicIdOf } from '../../src/shared/taxonomy.js';
import { admin, startAlgorithm } from '../helpers.js';

interface EntryView {
  id: string;
  title: string;
  rating: string;
  topics: string[];
  topicIds?: string[];
}

describe('age ratings in the catalog', () => {
  it('stores the age-rating topic with its topic id, one at a time', async () => {
    const node = await startAlgorithm({}, null);
    try {
      const topics = withAgeRatingTopic(['science'], ageRatingTopic('mpa', 'pg-13'));
      await admin(node.url(), '/v1/admin/content', {
        method: 'PUT',
        body: { id: 'vs1' + 'a'.repeat(52), title: 'Rated', format: 'video', rating: legacyRatingOf(topics[1]), topics, status: 'listed' },
      });
      const entry = (await admin<{ items: EntryView[] }>(node.url(), '/v1/admin/content')).items.find((item) => item.title === 'Rated');
      assert.deepEqual(entry?.topics, ['science', 'age-rating-mpa-pg-13']);
      assert.ok(entry?.topicIds?.includes(topicIdOf('age-rating-mpa-pg-13')), 'the topic filing follows the topic name');
      assert.equal(entry?.rating, '13+', 'the legacy rating comes from the age-rating topic');

      // Choosing another rating replaces the topic — exactly one at a time — and the
      // topic record of the new one is created along the way.
      const changed = withAgeRatingTopic(entry?.topics ?? [], ageRatingTopic('other', 'violence'));
      await admin(node.url(), '/v1/admin/content', {
        method: 'PUT',
        body: { id: entry?.id, rating: legacyRatingOf(changed[1]), topics: changed },
      });
      const again = (await admin<{ items: EntryView[] }>(node.url(), '/v1/admin/content')).items.find((item) => item.title === 'Rated');
      assert.deepEqual(again?.topics, ['science', 'age-rating-other-violence']);
      assert.ok(again?.topicIds?.includes(topicIdOf('age-rating-other-violence')));
      assert.ok((await admin<{ topics: { id: string }[] }>(node.url(), '/v1/admin/topics')).topics.some((topic) => topic.id === topicIdOf('age-rating-other-violence')));

      // Unknown removes the rating topic (kept as the unknown topic when asked for).
      const unknown = withAgeRatingTopic(again?.topics ?? [], UNKNOWN_AGE_RATING_TOPIC);
      await admin(node.url(), '/v1/admin/content', { method: 'PUT', body: { id: again?.id, rating: legacyRatingOf(unknown[1]), topics: unknown } });
      const last = (await admin<{ items: EntryView[] }>(node.url(), '/v1/admin/content')).items.find((item) => item.title === 'Rated');
      assert.deepEqual(last?.topics, ['science', UNKNOWN_AGE_RATING_TOPIC]);
      assert.equal(last?.rating, 'all', 'unknown maps to the legacy default');
    } finally {
      await node.stop();
    }
  });
});
