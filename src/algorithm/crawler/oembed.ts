import { embedFor, formatSource, sourceFromUrl, type ExternalSource } from '../../shared/sources.js';
import type { Format } from '../../shared/taxonomy.js';
import type { CrawlContext, Discovered } from './types.js';
import { inferTopics, videoFormat } from './types.js';

interface OEmbed {
  type?: string;
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  width?: number | string;
  height?: number | string;
  url?: string;
  html?: string;
}

/** oEmbed endpoints of the platforms whose links the crawler understands. */
export function oembedEndpoint(source: ExternalSource, page: string): string | null {
  const url = encodeURIComponent(page);
  switch (source.scheme) {
    case 'yt':
      return `https://www.youtube.com/oembed?format=json&url=${url}`;
    case 'vimeo':
      return `https://vimeo.com/api/oembed.json?url=${url}`;
    case 'dm':
      return `https://www.dailymotion.com/services/oembed?format=json&url=${url}`;
    case 'tiktok':
      return `https://www.tiktok.com/oembed?url=${url}`;
    case 'sc':
      return `https://soundcloud.com/oembed?format=json&url=${url}`;
    case 'spotify':
      return `https://open.spotify.com/oembed?url=${url}`;
    case 'x':
      return `https://publish.twitter.com/oembed?omit_script=1&url=${url}`;
    case 'bsky':
      return `https://embed.bsky.app/oembed?url=${url}`;
    case 'peertube':
      return `https://${source.value.split('/')[0]}/services/oembed?format=json&url=${url}`;
    case 'masto':
      return `https://${source.value.split('/')[0]}/api/oembed?url=${url}`;
    default:
      return null;
  }
}

const PLATFORM_KEYS: Partial<Record<ExternalSource['scheme'], string>> = {
  yt: 'youtube',
  vimeo: 'vimeo',
  dm: 'dailymotion',
  tiktok: 'tiktok',
  sc: 'soundcloud',
  spotify: 'spotify',
  x: 'x',
  bsky: 'bluesky',
  peertube: 'peertube',
  masto: 'mastodon',
  ig: 'instagram',
  twitch: 'twitch',
};

/** The format of content behind a platform link, before anything else is known. */
export function formatForSource(source: ExternalSource, page: string): Format {
  switch (source.scheme) {
    case 'tiktok':
      return 'short-video';
    case 'yt':
      return /\/shorts\//.test(page) ? 'short-video' : 'video';
    case 'ig':
      return source.value.startsWith('reel/') ? 'short-video' : 'image';
    case 'sc':
      return 'music';
    case 'spotify':
      return source.value.startsWith('episode:') || source.value.startsWith('show:') ? 'podcast' : 'music';
    case 'twitch':
      return 'live';
    case 'x':
    case 'bsky':
    case 'masto':
      return 'other';
    default:
      return 'video';
  }
}

/** Creator ids of platform accounts look like `youtube:@handle`. */
export function creatorFrom(platform: string, name: string | undefined, url: string | undefined): Discovered['creator'] {
  if (!name && !url) return undefined;
  let handle = name ?? '';
  if (url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/+$/, '');
      handle = path && path !== '/' ? `${parsed.host}${path}` : parsed.host;
    } catch {
      // keep the name
    }
  }
  return { id: `${platform}:${handle}`.slice(0, 120), name: name || handle, url };
}

/**
 * Turns a link to a known platform into an entry, asking the platform's oEmbed endpoint
 * for the title, author and thumbnail (subject to that platform's robots.txt).
 */
export async function identifyLink(ctx: CrawlContext, link: string, hint?: { title?: string }): Promise<Discovered | null> {
  const source = sourceFromUrl(link);
  if (!source || source.scheme === 'url' || source.scheme === 'ipfs') return null;
  const page = embedFor(source).page || link;
  const platform = PLATFORM_KEYS[source.scheme] ?? source.scheme;
  const endpoint = oembedEndpoint(source, link.startsWith('http') ? link : page);
  let data: OEmbed = {};
  if (endpoint) {
    try {
      data = (await ctx.fetcher.get(endpoint, { accept: 'application/json', maxBytes: 200_000 })).json<OEmbed>();
    } catch {
      if (!hint?.title) return null; // nothing to show for it
    }
  }
  const title = data.title || hint?.title;
  if (!title) return null;
  let format = formatForSource(source, link);
  const width = Number(data.width) || undefined;
  const height = Number(data.height) || undefined;
  if (format === 'video' && width && height) format = videoFormat(width, height);
  if (format === 'other' && data.type === 'video') format = videoFormat(width, height);
  if (format === 'other' && data.type === 'photo') format = 'image';
  return {
    id: formatSource(source),
    title: title.slice(0, 300),
    format,
    creator: creatorFrom(platform, data.author_name, data.author_url),
    thumbnailUrl: data.thumbnail_url,
    media: data.type === 'photo' && data.url ? { url: data.url, type: 'image', width, height } : undefined,
    pageUrl: page,
    topics: inferTopics(title),
    adapter: 'web',
  };
}
