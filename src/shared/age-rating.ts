// Topic-encoded age ratings: a content's age rating is one of its topics, so it
// travels, filters and edits like every other piece of taxonomy — no separate field
// to keep in step. The shapes:
//
//   age-rating-mpa-pg          one category of one rating system
//   age-rating-esrb-e10+       (slugs are lowercase; spaces become dashes)
//   age-rating-other-violence  a free-text rating ("Other" in any system)
//   rating-unknown             no rating known (the default; scraped content has none)
//
// Exactly one age-rating topic lives on a content at a time (withAgeRatingTopic).
// The legacy `rating` field (all/10+/13+/16+/18+/nsfw) stays for filtering and older
// clients; legacyRatingOf derives it from the topic (see the per-category mapping).
// Browser-safe: no Node imports.
import { RATINGS, type Rating } from './taxonomy.js';

/** The topic of a content with no known age rating — the default. */
export const UNKNOWN_AGE_RATING_TOPIC = 'rating-unknown';
/** Every category-based age-rating topic starts with this. */
export const AGE_RATING_PREFIX = 'age-rating-';
/** The system of a free-text rating ("Other" in any system's category list). */
export const OTHER_AGE_RATING_SYSTEM = 'other';
/** The system/category of an unknown rating. */
export const UNKNOWN_AGE_RATING = 'unknown';

/** One category of a rating system, and the legacy rating bucket it maps to. */
export interface AgeRatingCategory {
  label: string;
  /** The stable id: the slug of the label (what the topic carries). */
  slug: string;
  /** The closest legacy rating (see legacyRatingOf's mapping notes). */
  legacy: Rating;
}

/** One age-rating system (MPA, PEGI…): its label, its categories, an optional note. */
export interface AgeRatingSystem {
  id: string;
  label: string;
  /** Shown instead of categories when the system publishes none of its own. */
  note?: string;
  categories: AgeRatingCategory[];
}

/** The parsed shape of a content's age rating: which system, which category (slug). */
export interface AgeRating {
  system: string;
  category: string;
}

/** Lowercase, dash-separated, nothing the topic vocabulary would strip. */
function slug(text: string): string {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9+_\-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Categories from their display labels; the slug is derived and never changes. */
function categories(entries: [string, Rating][]): AgeRatingCategory[] {
  return entries.map(([label, legacy]) => ({ label, slug: slug(label), legacy }));
}

/**
 * The rating systems and their categories. The legacy mapping is the closest bucket
 * of all/10+/13+/16+/18+/nsfw, judged per category (G-level → all, teen levels →
 * 13+, adult-only → 18+, sexually explicit → nsfw; pending/unrated → all).
 */
export const AGE_RATING_SYSTEMS: AgeRatingSystem[] = [
  {
    id: 'mpa',
    label: 'MPA film ratings (Films, US)',
    categories: categories([
      ['G', 'all'],
      ['PG', 'all'],
      ['PG-13', '13+'],
      ['R', '18+'],
      ['NC-17', '18+'],
    ]),
  },
  {
    id: 'tv',
    label: 'TV Parental Guidelines (TV, US)',
    categories: categories([
      ['TV-Y', 'all'],
      ['TV-Y7', 'all'],
      ['TV-G', 'all'],
      ['TV-PG', 'all'],
      ['TV-14', '13+'],
      ['TV-MA', '18+'],
    ]),
  },
  {
    id: 'esrb',
    label: 'ESRB (games, US/Canada)',
    categories: categories([
      ['E', 'all'],
      ['E10+', '10+'],
      ['T', '13+'],
      ['M', '18+'],
      ['AO', '18+'],
      ['RP', 'all'],
    ]),
  },
  {
    id: 'pegi',
    label: 'PEGI (games, Europe)',
    categories: categories([
      ['3', 'all'],
      ['7', 'all'],
      ['12', '13+'],
      ['16', '16+'],
      ['18', '18+'],
    ]),
  },
  {
    id: 'cero',
    label: 'CERO (games, Japan)',
    categories: categories([
      ['A', 'all'],
      ['B', '13+'],
      ['C', '16+'],
      ['D', '18+'],
      ['Z', '18+'],
    ]),
  },
  {
    id: 'usk',
    label: 'USK (games, Germany)',
    categories: categories([
      ['0', 'all'],
      ['6', 'all'],
      ['12', '13+'],
      ['16', '16+'],
      ['18', '18+'],
    ]),
  },
  {
    id: 'bbfc',
    label: 'BBFC (UK film/video)',
    categories: categories([
      ['U', 'all'],
      ['PG', 'all'],
      ['12A/12', '13+'],
      ['15', '16+'],
      ['18', '18+'],
      ['R18', 'nsfw'],
    ]),
  },
  {
    id: 'au',
    label: 'Australian Classification (AU)',
    categories: categories([
      ['G', 'all'],
      ['PG', 'all'],
      ['M', '13+'],
      ['MA 15+', '16+'],
      ['R 18+', '18+'],
      ['X 18+', 'nsfw'],
      ['RC', 'nsfw'],
      ['CTC', 'all'],
    ]),
  },
  {
    id: 'classind',
    label: 'Brazilian ClassInd (BR)',
    categories: categories([
      ['Livre', 'all'],
      ['10', '10+'],
      ['12', '13+'],
      ['14', '13+'],
      ['16', '16+'],
      ['18', '18+'],
    ]),
  },
  {
    id: 'iarc',
    label: 'IARC (digital games/apps, regional stores)',
    note: 'IARC issues no labels of its own: storefronts display the applicable local rating (ESRB, PEGI, USK, …). Pick Other to name it.',
    categories: [],
  },
];

const SYSTEM_BY_ID = new Map(AGE_RATING_SYSTEMS.map((system) => [system.id, system]));

/** The rating system of an id ('mpa', 'pegi'…), when there is one. */
export function ageRatingSystem(id: string): AgeRatingSystem | undefined {
  return SYSTEM_BY_ID.get(String(id ?? '').trim().toLowerCase());
}

/** Whether this topic is an age-rating topic (the unknown topic included). */
export function isAgeRatingTopic(topic: string): boolean {
  return topic === UNKNOWN_AGE_RATING_TOPIC || String(topic).startsWith(AGE_RATING_PREFIX);
}

/** The one age-rating topic of a list, when it has one (a real rating beats unknown). */
export function findAgeRatingTopic(topics: readonly string[] | undefined): string | null {
  let unknown: string | null = null;
  for (const topic of topics ?? []) {
    if (!isAgeRatingTopic(topic)) continue;
    if (topic === UNKNOWN_AGE_RATING_TOPIC) unknown = topic;
    else return topic;
  }
  return unknown;
}

/**
 * The topic of one age rating: `age-rating-<system>-<category>` for a category (the
 * slug or the label both work), `age-rating-other-<text>` for a free-text rating
 * (system 'other'), and `rating-unknown` whenever the system or the category is
 * unknown — the default every scraped content has.
 */
export function ageRatingTopic(system: string, category: string): string {
  const systemId = String(system ?? '').trim().toLowerCase();
  const raw = String(category ?? '').trim();
  if (systemId === UNKNOWN_AGE_RATING || raw.toLowerCase() === UNKNOWN_AGE_RATING || !raw) return UNKNOWN_AGE_RATING_TOPIC;
  if (systemId === OTHER_AGE_RATING_SYSTEM) return `${AGE_RATING_PREFIX}other-${slug(raw)}`;
  const known = SYSTEM_BY_ID.get(systemId);
  if (!known) throw new Error(`Not a rating system: ${system}`);
  if (!known.categories.some((entry) => entry.slug === slug(raw))) throw new Error(`Not a category of ${known.label}: ${category}`);
  return `${AGE_RATING_PREFIX}${systemId}-${slug(raw)}`;
}

/**
 * The age rating a topic list carries, or null when it has none (which is unknown —
 * the default). A free-text rating parses as system 'other' with its normalised text.
 */
/** The age rating one topic carries, or null when the topic is not an age rating. */
export function parseAgeRatingTopic(topic: string): AgeRating | null {
  if (!isAgeRatingTopic(topic)) return null;
  if (topic === UNKNOWN_AGE_RATING_TOPIC) return { system: UNKNOWN_AGE_RATING, category: UNKNOWN_AGE_RATING };
  const rest = topic.slice(AGE_RATING_PREFIX.length);
  if (rest.startsWith(`${OTHER_AGE_RATING_SYSTEM}-`)) return { system: OTHER_AGE_RATING_SYSTEM, category: rest.slice(OTHER_AGE_RATING_SYSTEM.length + 1) };
  // The system is the id the rest opens with; longest first so no id shadows another.
  for (const system of [...AGE_RATING_SYSTEMS].sort((a, b) => b.id.length - a.id.length)) {
    if (rest.startsWith(`${system.id}-`)) return { system: system.id, category: rest.slice(system.id.length + 1) };
  }
  return null;
}

export function parseAgeRating(topics: readonly string[] | undefined): AgeRating | null {
  const topic = findAgeRatingTopic(topics);
  return topic ? parseAgeRatingTopic(topic) : null;
}

/**
 * Every age rating a topic list carries, in order — several systems at once: one per
 * known system, any number of free-text "other" ratings, the unknown marker included.
 */
export function parseAgeRatings(topics: readonly string[] | undefined): AgeRating[] {
  const ratings: AgeRating[] = [];
  for (const topic of topics ?? []) {
    const parsed = parseAgeRatingTopic(topic);
    if (parsed) ratings.push(parsed);
  }
  return ratings;
}

/**
 * The topic list with this age rating added: a known system keeps exactly one rating
 * (the new category takes the old one's place, order kept), the unknown marker stays
 * one, and each custom "other" rating joins the rest (the same free text is not added
 * twice). Non-rating topics are untouched.
 */
export function addAgeRatingTopic(topics: readonly string[], topic: string): string[] {
  const parsed = parseAgeRatingTopic(topic);
  if (!parsed) return [...topics];
  const accumulates = parsed.system === OTHER_AGE_RATING_SYSTEM;
  const out: string[] = [];
  let placed = false;
  for (const entry of topics) {
    const other = parseAgeRatingTopic(entry);
    const clashes = other !== null && (entry === topic || (!accumulates && other.system === parsed.system));
    if (clashes) {
      if (!placed) {
        out.push(topic);
        placed = true;
      }
      continue;
    }
    out.push(entry);
  }
  if (!placed) out.push(topic);
  return out;
}

/**
 * The topic list with one age rating removed: the one of a known system (which keeps
 * exactly one at a time), or — given its free text — the one custom rating. Without a
 * text, every custom rating goes.
 */
export function removeAgeRatingTopic(topics: readonly string[], system: string, text?: string): string[] {
  const systemId = String(system ?? '').trim().toLowerCase();
  const wanted = String(text ?? '').trim();
  return topics.filter((entry) => {
    const parsed = parseAgeRatingTopic(entry);
    if (!parsed || parsed.system !== systemId) return true;
    return systemId === OTHER_AGE_RATING_SYSTEM && wanted !== '' && parsed.category !== slug(wanted);
  });
}

/**
 * The topic list with this age rating set: every age-rating topic is replaced by the
 * one given (or removed entirely when null) — exactly one at a time. The other topics
 * are untouched, in their existing order.
 */
export function withAgeRatingTopic(topics: readonly string[], topic: string | null): string[] {
  const kept = (topics ?? []).filter((entry) => !isAgeRatingTopic(entry));
  return topic ? [...kept, topic] : kept;
}

/**
 * The legacy rating (all/10+/13+/16+/18+/nsfw) an age rating maps to — the closest
 * bucket, judged per category in the table above (an unknown or free-text rating maps
 * to 'all', the legacy default). Accepts the parsed form or the topic itself.
 */
/**
 * The legacy rating a whole topic list maps to: the bucket of the one age rating it
 * carries ('all' when it has none — the legacy default, like a free-text rating).
 */
export function legacyRatingOfTopics(topics: readonly string[] | undefined): Rating {
  // The strictest bucket of every rating the list carries (none maps to the default).
  let strongest: Rating = 'all';
  for (const parsed of parseAgeRatings(topics)) {
    const legacy = legacyRatingOf(parsed);
    if (RATINGS.indexOf(legacy) > RATINGS.indexOf(strongest)) strongest = legacy;
  }
  return strongest;
}

export function legacyRatingOf(rating: AgeRating | string): Rating {
  const parsed = typeof rating === 'string' ? parseAgeRating([rating]) : rating;
  if (!parsed) return 'all';
  const system = SYSTEM_BY_ID.get(parsed.system);
  return system?.categories.find((entry) => entry.slug === parsed.category)?.legacy ?? 'all';
}
