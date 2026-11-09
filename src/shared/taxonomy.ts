// Content metadata vocabulary shared by every node and the GUI. Browser-safe: no Node imports.
import { sha256hex } from './crypto.js';

export const FORMATS = [
  'video',
  'short-video',
  'live',
  'music',
  'audio',
  'podcast',
  'image',
  'image-list',
  'article',
  'game',
  'software',
  'book',
  'file',
  'other',
] as const;
export type Format = (typeof FORMATS)[number];

export const FORMAT_LABELS: Record<Format, string> = {
  video: 'Video',
  'short-video': 'Short video',
  live: 'Live',
  music: 'Music',
  audio: 'Audio',
  podcast: 'Podcast',
  image: 'Image',
  'image-list': 'Image list',
  article: 'Article',
  game: 'Game',
  software: 'Software',
  book: 'Book',
  file: 'File',
  other: 'Other',
};

/** Age ratings from least to most restricted. A viewer's limit admits every rating up to it. */
export const RATINGS = ['all', '10+', '13+', '16+', '18+', 'nsfw'] as const;
export type Rating = (typeof RATINGS)[number];

export const RATING_LABELS: Record<Rating, string> = {
  all: 'All ages',
  '10+': '10+',
  '13+': '13+',
  '16+': '16+',
  '18+': '18+',
  nsfw: 'NSFW',
};

export function ratingAllowed(rating: Rating | undefined, limit: Rating | undefined): boolean {
  if (!limit) return true;
  return RATINGS.indexOf(rating ?? 'all') <= RATINGS.indexOf(limit);
}

export const CREATOR_KINDS = ['person', 'company', 'group', 'unknown'] as const;
export type CreatorKind = (typeof CREATOR_KINDS)[number];

/**
 * The id of a topic: a hash of its normalized name (`tp1…`). A topic is never keyed by
 * its name, so the id is what content, pages and subscriptions carry — and every node
 * and client computing it from the same name lands on the same topic.
 */
export function topicIdOf(name: string): string {
  return `tp1${sha256hex(normalizeTag(name)).slice(0, 32)}`;
}

export const CREATOR_KIND_LABELS: Record<CreatorKind, string> = {
  person: 'Person',
  company: 'Company',
  group: 'Group',
  unknown: 'Unknown',
};

/** Suggested topics. Algorithm nodes may use any topic string; these are the defaults offered in the GUI. */
export const TOPICS = [
  'science',
  'learning',
  'technology',
  'gaming',
  'music',
  'art',
  'news',
  'comedy',
  'sports',
  'health',
  'cooking',
  'travel',
  'nature',
  'history',
  'politics',
  'business',
  'film',
  'kids',
  'diy',
  'lifestyle',
] as const;

export function guessFormat(mime: string, durationSeconds?: number): Format {
  if (mime.startsWith('video/')) return durationSeconds !== undefined && durationSeconds <= 90 ? 'short-video' : 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'text/markdown' || mime === 'text/plain' || mime === 'text/html') return 'article';
  if (mime === 'application/pdf' || mime === 'application/epub+zip') return 'book';
  return 'file';
}

export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_+-]/gu, '')
    .slice(0, 48);
}

/** The preset reason tags of an age rating. A page can disregard content about them. */
export const RATING_REASONS = ['violence', 'language', 'sexual content', 'nudity', 'drugs', 'fear', 'gambling', 'hate speech'] as const;
export type RatingReason = (typeof RATING_REASONS)[number];

/**
 * How strongly one set of picks (formats, topics or creators) weighs in the recommendations
 * an algorithm node returns: from "only show these" down to "ignore them entirely".
 */
export const SUGGEST_LEVELS = ['only', 'strongly', 'suggest', 'weakly', 'ignore'] as const;
export type SuggestLevel = (typeof SUGGEST_LEVELS)[number];

export const SUGGEST_LEVEL_LABELS: Record<SuggestLevel, string> = {
  only: 'Only show',
  strongly: 'Strongly suggest',
  suggest: 'Suggest',
  weakly: 'Weakly suggest',
  ignore: 'Ignore',
};

/**
 * Whether anything in a content's metadata conflicts with the content types a viewer
 * disregards: the age-rating reason notes algorithm nodes tag entries with (or any mention
 * of the reason in the tags, topics or description). The client applies this itself on top
 * of whatever the algorithm nodes already filtered.
 */
export function conflictsWithDisregard(
  meta: { description?: string; tags?: string[]; topics?: string[]; notes?: { kind: string; value: string; reason: string }[] },
  disregard: readonly string[]
): boolean {
  const reasons = disregard.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!reasons.length) return false;
  const mentioned = [
    meta.description ?? '',
    ...(meta.topics ?? []),
    ...(meta.notes ?? []).flatMap((note) => [note.value, note.reason]),
  ];
  return mentioned.some((text) => Boolean(text) && reasons.some((reason) => text.toLowerCase().includes(reason)));
}
