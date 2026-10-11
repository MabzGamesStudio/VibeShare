// Content metadata vocabulary shared by every node and the GUI. Browser-safe: no Node imports.

export const FORMATS = [
  'video',
  'short-video',
  'live',
  'music',
  'audio',
  'podcast',
  'image',
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
