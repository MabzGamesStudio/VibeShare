// The topic-encoded age ratings: the encoding is deterministic and round-trips, one
// age-rating topic lives on a content at a time, and the legacy rating is derived.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {

  AGE_RATING_PREFIX,
  AGE_RATING_SYSTEMS,
  UNKNOWN_AGE_RATING_TOPIC,
  ageRatingTopic,
  findAgeRatingTopic,
  isAgeRatingTopic,
  legacyRatingOf,
  parseAgeRating,
  withAgeRatingTopic,
  legacyRatingOfTopics,
  parseAgeRatings,
  addAgeRatingTopic,
  removeAgeRatingTopic,
  parseAgeRatingTopic,
} from '../../src/shared/age-rating.js';

describe('age ratings as topics', () => {
  it('encodes the documented topics exactly', () => {
    assert.equal(ageRatingTopic('mpa', 'pg'), 'age-rating-mpa-pg');
    assert.equal(ageRatingTopic('mpa', 'PG-13'), 'age-rating-mpa-pg-13');
    assert.equal(ageRatingTopic('esrb', 'E10+'), 'age-rating-esrb-e10+');
    assert.equal(ageRatingTopic('bbfc', '12A/12'), 'age-rating-bbfc-12a-12');
    assert.equal(ageRatingTopic('au', 'MA 15+'), 'age-rating-au-ma-15+');
    assert.equal(ageRatingTopic('other', 'Violence'), 'age-rating-other-violence');
    assert.equal(ageRatingTopic('unknown', 'unknown'), UNKNOWN_AGE_RATING_TOPIC);
    assert.equal(ageRatingTopic('mpa', 'unknown'), UNKNOWN_AGE_RATING_TOPIC, 'Unknown is the same topic in every system');
    assert.equal(ageRatingTopic('other', ''), UNKNOWN_AGE_RATING_TOPIC, 'an empty free text is no rating at all');
  });

  it('round-trips every category of every system through its topic', () => {
    for (const system of AGE_RATING_SYSTEMS) {
      for (const category of system.categories) {
        const topic = ageRatingTopic(system.id, category.slug);
        assert.equal(topic, `${AGE_RATING_PREFIX}${system.id}-${category.slug}`, `${system.id}/${category.label} has a stable topic`);
        assert.deepEqual(parseAgeRating([topic]), { system: system.id, category: category.slug });
        // The display label encodes to the very same topic as its slug.
        assert.equal(ageRatingTopic(system.id, category.label), topic);
      }
    }
    assert.deepEqual(parseAgeRating(['age-rating-other-violence']), { system: 'other', category: 'violence' });
    assert.deepEqual(parseAgeRating([UNKNOWN_AGE_RATING_TOPIC]), { system: 'unknown', category: 'unknown' });
  });

  it('parses only what is there, and a real rating beats unknown', () => {
    assert.equal(parseAgeRating([]), null, 'no topics: no rating');
    assert.equal(parseAgeRating(['science', 'nature']), null, 'ordinary topics are not ratings');
    assert.deepEqual(parseAgeRating(['science', UNKNOWN_AGE_RATING_TOPIC]), { system: 'unknown', category: 'unknown' });
    assert.deepEqual(
      parseAgeRating([UNKNOWN_AGE_RATING_TOPIC, 'age-rating-pegi-16']),
      { system: 'pegi', category: '16' },
      'a real rating wins when both are somehow present'
    );
    for (const topic of ['rating-unknown', 'age-rating-mpa-pg', 'age-rating-other-x']) assert.ok(isAgeRatingTopic(topic));
    assert.equal(isAgeRatingTopic('ratings-folk'), false);
    assert.equal(findAgeRatingTopic(['a', 'age-rating-tv-tv-14']), 'age-rating-tv-tv-14');
    assert.equal(findAgeRatingTopic(['a']), null);
  });

  it('keeps exactly one age-rating topic in the list', () => {
    const topics = ['science', 'age-rating-mpa-pg', 'nature'];
    const changed = withAgeRatingTopic(topics, 'age-rating-pegi-18');
    assert.deepEqual(changed, ['science', 'nature', 'age-rating-pegi-18'], 'the old rating is replaced, the rest kept in order');
    assert.deepEqual(withAgeRatingTopic([...changed, UNKNOWN_AGE_RATING_TOPIC], 'age-rating-esrb-t'), [
      'science',
      'nature',
      'age-rating-esrb-t',
    ], 'even a stray unknown topic goes when the rating is set');
    assert.deepEqual(withAgeRatingTopic(topics, null), ['science', 'nature'], 'null removes the rating entirely');
    assert.deepEqual(withAgeRatingTopic(['age-rating-other-gore'], UNKNOWN_AGE_RATING_TOPIC), [UNKNOWN_AGE_RATING_TOPIC]);
  });

  it('derives the legacy rating from the category', () => {
    assert.equal(legacyRatingOf('age-rating-mpa-g'), 'all');
    assert.equal(legacyRatingOf('age-rating-mpa-pg-13'), '13+');
    assert.equal(legacyRatingOf('age-rating-mpa-r'), '18+');
    assert.equal(legacyRatingOf('age-rating-tv-tv-14'), '13+');
    assert.equal(legacyRatingOf('age-rating-esrb-e10+'), '10+');
    assert.equal(legacyRatingOf('age-rating-esrb-m'), '18+');
    assert.equal(legacyRatingOf('age-rating-pegi-16'), '16+');
    assert.equal(legacyRatingOf('age-rating-cero-z'), '18+');
    assert.equal(legacyRatingOf('age-rating-usk-0'), 'all');
    assert.equal(legacyRatingOf('age-rating-bbfc-r18'), 'nsfw');
    assert.equal(legacyRatingOf('age-rating-au-x-18+'), 'nsfw');
    assert.equal(legacyRatingOf('age-rating-au-rc'), 'nsfw');
    assert.equal(legacyRatingOf('age-rating-classind-livre'), 'all');
    assert.equal(legacyRatingOf(UNKNOWN_AGE_RATING_TOPIC), 'all', 'unknown is the legacy default');
    assert.equal(legacyRatingOf('age-rating-other-violence'), 'all', 'a free-text rating maps to the legacy default');
  });

  it('carries several age ratings at once', () => {
    // One per known system, any number of free-text ratings, one unknown marker.
    let topics = addAgeRatingTopic([], ageRatingTopic('mpa', 'PG-13'));
    topics = addAgeRatingTopic(topics, ageRatingTopic('classind', '12'));
    topics = addAgeRatingTopic(topics, ageRatingTopic('other', 'violence'));
    topics = addAgeRatingTopic(topics, ageRatingTopic('other', 'fear'));
    assert.deepEqual(parseAgeRatings(topics).map((rating) => rating.system), ['mpa', 'classind', 'other', 'other']);
    assert.deepEqual(parseAgeRatings(topics).filter((rating) => rating.system === 'other').map((rating) => rating.category), ['violence', 'fear']);

    // A known system keeps exactly one: its new category takes the old one's place.
    topics = addAgeRatingTopic(topics, ageRatingTopic('mpa', 'R'));
    assert.deepEqual(parseAgeRatings(topics).map((rating) => `${rating.system}:${rating.category}`), ['mpa:r', 'classind:12', 'other:violence', 'other:fear']);

    // The same free text twice is one rating; other topics are untouched.
    const withTwins = addAgeRatingTopic(['movies', ...topics], ageRatingTopic('other', 'violence'));
    assert.equal(withTwins.filter((topic) => topic === 'age-rating-other-violence').length, 1);
    assert.equal(withTwins[0], 'movies');

    // Removing: by system (its one rating), by free text (that one custom rating).
    const fewer = removeAgeRatingTopic(withTwins, 'mpa');
    assert.ok(!fewer.some((topic) => topic.startsWith('age-rating-mpa-')));
    const oneLess = removeAgeRatingTopic(fewer, 'other', 'fear');
    assert.ok(oneLess.includes('age-rating-other-violence'));
    assert.ok(!oneLess.includes('age-rating-other-fear'));
  });

  it('maps a whole topic list to the legacy rating bucket', () => {
    assert.equal(legacyRatingOfTopics([]), 'all', 'no rating is the legacy default');
    assert.equal(legacyRatingOfTopics(['movies', UNKNOWN_AGE_RATING_TOPIC]), 'all');
    assert.equal(legacyRatingOfTopics(['movies', ageRatingTopic('mpa', 'G')]), 'all', 'G lands in the all bucket');
    assert.equal(legacyRatingOfTopics(['movies', ageRatingTopic('mpa', 'PG-13')]), '13+');
    // Several ratings at once map to the strongest of them.
    assert.equal(
      legacyRatingOfTopics([ageRatingTopic('mpa', 'G'), ageRatingTopic('mpa', 'PG-13'), ageRatingTopic('classind', '18')]),
      '18+',
      'the strictest bucket wins'
    );
  });
});
