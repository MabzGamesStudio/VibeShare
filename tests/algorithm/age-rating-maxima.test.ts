// The per-system age-rating maximums of the viewer's preferences: content rated
// stricter than a maximum in its own system is hidden, and every rating the maximum does
// not name — another system, or none at all — is kept, like unknown always has been.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Registry } from '../../src/algorithm/registry.js';
import { ageRatingTopic } from '../../src/shared/age-rating.js';
import type { Preferences } from '../../src/shared/protocol.js';

/** A registry with one listed entry per rating under test (and one with none). */
function makeRegistry() {
  const registry = new Registry(null, null);
  registry.upsert({
    id: 'yt:pg13',
    status: 'listed',
    title: 'A PG-13 film',
    format: 'video',
    rating: '13+',
    topics: [ageRatingTopic('mpa', 'PG-13')],
  });
  registry.upsert({
    id: 'yt:class16',
    status: 'listed',
    title: 'A ClassInd 16 show',
    format: 'video',
    rating: '16+',
    topics: [ageRatingTopic('classind', '16')],
  });
  registry.upsert({ id: 'yt:plain', status: 'listed', title: 'Nothing rated', format: 'video', rating: 'all', topics: [] });
  return registry;
}

/** The listed entries the preferences show, by id. */
function visibleIds(registry: Registry, ageRatingMaxima: { system: string; category: string }[]): Set<string> {
  return new Set(registry.visible({ maxRating: 'nsfw', ageRatingMaxima } as Preferences, 'nsfw').map((entry) => entry.id));
}

describe('age-rating maximums', () => {
  it('hides a rating stricter than the maximum, and keeps the maximum itself', () => {
    const registry = makeRegistry();
    assert.ok(!visibleIds(registry, [{ system: 'mpa', category: 'PG' }]).has('yt:pg13'), 'PG-13 is over an MPA PG maximum');
    assert.ok(visibleIds(registry, [{ system: 'mpa', category: 'PG-13' }]).has('yt:pg13'), 'PG-13 is allowed at an MPA PG-13 maximum');
    assert.ok(visibleIds(registry, [{ system: 'mpa', category: 'pg-13' }]).has('yt:pg13'), 'the category matches by slug or label');
    assert.ok(visibleIds(registry, [{ system: 'mpa', category: 'R' }]).has('yt:pg13'), 'a looser maximum keeps it too');
  });

  it('applies every system at once, each to its own ratings', () => {
    const registry = makeRegistry();
    assert.ok(!visibleIds(registry, [{ system: 'classind', category: '14' }]).has('yt:class16'), 'ClassInd 16 is over a ClassInd 14 maximum');
    assert.ok(visibleIds(registry, [{ system: 'classind', category: '16' }]).has('yt:class16'), 'ClassInd 16 is allowed at a ClassInd 16 maximum');
    assert.ok(visibleIds(registry, [{ system: 'mpa', category: 'PG' }]).has('yt:class16'), 'an MPA maximum says nothing about a ClassInd rating');
    const both = visibleIds(registry, [
      { system: 'mpa', category: 'PG' },
      { system: 'classind', category: '14' },
    ]);
    assert.ok(!both.has('yt:pg13') && !both.has('yt:class16'), 'both maxima apply at the same time');
  });

  it('keeps entries with no rating for that system — unknown passes', () => {
    const registry = makeRegistry();
    const shown = visibleIds(registry, [
      { system: 'mpa', category: 'G' },
      { system: 'classind', category: 'Livre' },
    ]);
    assert.ok(shown.has('yt:plain'), 'an entry with no rating is kept, like every unknown');
    assert.ok(shown.has('yt:class16') === false && shown.has('yt:pg13') === false, 'the strict maxima still hide what they name');
  });
});
