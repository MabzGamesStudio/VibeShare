// Where content comes from ("source origin types"): VibeShare itself or another platform.
// Operators choose which sources the crawler may use and how strongly each is favoured.
import { parseContentId } from '../shared/sources.js';

export interface SourceInfo {
  key: string;
  name: string;
}

/** Every source an operator can set a priority for, in display order. */
export const SOURCE_CATALOG: SourceInfo[] = [
  { key: 'vibeshare', name: 'VibeShare (published on providers)' },
  { key: 'youtube', name: 'YouTube' },
  { key: 'peertube', name: 'PeerTube' },
  { key: 'vimeo', name: 'Vimeo' },
  { key: 'dailymotion', name: 'Dailymotion' },
  { key: 'twitch', name: 'Twitch' },
  { key: 'tiktok', name: 'TikTok' },
  { key: 'archive', name: 'Internet Archive' },
  { key: 'wikimedia', name: 'Wikimedia Commons' },
  { key: 'openverse', name: 'Openverse' },
  { key: 'flickr', name: 'Flickr' },
  { key: 'unsplash', name: 'Unsplash' },
  { key: 'pexels', name: 'Pexels' },
  { key: 'giphy', name: 'GIPHY' },
  { key: 'tenor', name: 'Tenor' },
  { key: 'imgur', name: 'Imgur' },
  { key: 'deviantart', name: 'DeviantArt' },
  { key: 'europeana', name: 'Europeana' },
  { key: 'reddit', name: 'Reddit' },
  { key: 'tumblr', name: 'Tumblr' },
  { key: 'x', name: 'X' },
  { key: 'instagram', name: 'Instagram' },
  { key: 'mastodon', name: 'Mastodon' },
  { key: 'bluesky', name: 'Bluesky' },
  { key: 'lemmy', name: 'Lemmy' },
  { key: 'spotify', name: 'Spotify' },
  { key: 'soundcloud', name: 'SoundCloud' },
  { key: 'jamendo', name: 'Jamendo' },
  { key: 'freesound', name: 'Freesound' },
  { key: 'ipfs', name: 'IPFS' },
  { key: 'web', name: 'Other websites' },
];

const KNOWN = new Set(SOURCE_CATALOG.map((source) => source.key));

const SCHEMES: Record<string, string> = {
  yt: 'youtube',
  vimeo: 'vimeo',
  dm: 'dailymotion',
  peertube: 'peertube',
  ia: 'archive',
  ig: 'instagram',
  x: 'x',
  bsky: 'bluesky',
  masto: 'mastodon',
  tiktok: 'tiktok',
  twitch: 'twitch',
  spotify: 'spotify',
  sc: 'soundcloud',
  ipfs: 'ipfs',
};

const HOSTS: [string, string][] = [
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['vimeo.com', 'vimeo'],
  ['dailymotion.com', 'dailymotion'],
  ['twitch.tv', 'twitch'],
  ['tiktok.com', 'tiktok'],
  ['archive.org', 'archive'],
  ['wikimedia.org', 'wikimedia'],
  ['wikipedia.org', 'wikimedia'],
  ['openverse.org', 'openverse'],
  ['flickr.com', 'flickr'],
  ['staticflickr.com', 'flickr'],
  ['unsplash.com', 'unsplash'],
  ['pexels.com', 'pexels'],
  ['giphy.com', 'giphy'],
  ['tenor.com', 'tenor'],
  ['imgur.com', 'imgur'],
  ['deviantart.com', 'deviantart'],
  ['europeana.eu', 'europeana'],
  ['reddit.com', 'reddit'],
  ['redd.it', 'reddit'],
  ['tumblr.com', 'tumblr'],
  ['x.com', 'x'],
  ['twitter.com', 'x'],
  ['instagram.com', 'instagram'],
  ['bsky.app', 'bluesky'],
  ['spotify.com', 'spotify'],
  ['soundcloud.com', 'soundcloud'],
  ['jamendo.com', 'jamendo'],
  ['freesound.org', 'freesound'],
];

/** The source of a host name, if it is a known platform. */
export function sourceOfHost(host: string): string | undefined {
  const clean = host.toLowerCase().replace(/^www\./, '');
  return HOSTS.find(([domain]) => clean === domain || clean.endsWith(`.${domain}`))?.[1];
}

/**
 * The source of a content id: VibeShare for native content, otherwise the platform the
 * content lives on (from the id's source or link), or the crawler adapter that found it.
 */
export function sourceKeyOf(entry: { id: string; adapter?: string }): string {
  const parsed = parseContentId(entry.id);
  if (!parsed || parsed.native) return 'vibeshare';
  const source = parsed.sources[0];
  if (source.scheme !== 'url') return SCHEMES[source.scheme] ?? 'web';
  let host = '';
  try {
    host = new URL(decodeURIComponent(source.value)).hostname;
  } catch {
    // not a link
  }
  return sourceOfHost(host) ?? (entry.adapter && KNOWN.has(entry.adapter) ? entry.adapter : 'web');
}

/** Priorities 0–10; VibeShare's own content comes first unless the operator says otherwise. */
export function priorityOf(key: string, priorities: Record<string, number>): number {
  const value = priorities[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : key === 'vibeshare' ? 10 : 5;
}

/**
 * Applies source priorities to a ranked list: sources at 0 are left out, and content of
 * a higher-priority source always comes before content of a lower-priority one (the
 * ranking's order is kept within a source). With every source at the same priority the
 * ranking is unchanged.
 */
export function prioritize<T extends { id: string; adapter?: string }>(items: T[], priorities: Record<string, number>): T[] {
  return items
    .map((item, index) => ({ item, index, priority: priorityOf(sourceKeyOf(item), priorities) }))
    .filter(({ priority }) => priority > 0)
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map(({ item }) => item);
}
