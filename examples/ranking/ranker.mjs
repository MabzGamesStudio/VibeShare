// A custom ranking for an algorithm node. Point `ranking.module` at this file and
// set `ranking.strategy` to "custom". The default export receives the entries that
// passed the viewer's filters and returns them in order — or an object of scores
// by entry id (higher first). It may be async (e.g. to call your own ML service).
//
// entry: { id, title, format, rating, topics, tags, creatorId, publishedAt, likes, dislikes, durationSeconds, … }
// context: { preferences, seed, now, config, helpers: { wilson, quality, recency, preferenceMatch, seededRandom } }

export default function rank(entries, { preferences, seed, now, config, helpers }) {
  const creatorCounts = new Map();
  for (const entry of entries) creatorCounts.set(entry.creatorId, (creatorCounts.get(entry.creatorId) ?? 0) + 1);

  const scores = {};
  for (const entry of entries) {
    let score =
      1.2 * helpers.wilson(entry.likes, entry.dislikes) +
      0.6 * helpers.recency(entry, now, config.halfLifeHours) +
      1.5 * helpers.preferenceMatch(entry, preferences) +
      0.3 * helpers.seededRandom(seed, entry.id);
    // Long-form explainers first.
    if ((entry.durationSeconds ?? 0) > 600) score += 0.3;
    // Give creators with little content a chance to be seen.
    if ((creatorCounts.get(entry.creatorId) ?? 0) <= 2) score += 0.2;
    scores[entry.id] = score;
  }
  return scores;
}
