import { cleanText } from '../html.js';
import type { Adapter, CrawlContext, Discovered } from '../types.js';
import { inferTopics, toIso, videoFormat } from '../types.js';

// ---------------------------------------------------------------------------
// Wikimedia Commons: freely licensed images, video and audio through the MediaWiki API.

export interface WikimediaConfig {
  enabled: boolean;
  apiUrl: string;
}

interface CommonsPage {
  title?: string;
  imageinfo?: {
    url?: string;
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    width?: number;
    height?: number;
    mime?: string;
    user?: string;
    timestamp?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: string }>;
  }[];
}

export function mapCommons(page: CommonsPage): Discovered | null {
  const info = page.imageinfo?.[0];
  if (!page.title || !info?.url || !info.descriptionurl) return null;
  const title = page.title.replace(/^File:/, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
  const description = info.extmetadata?.ImageDescription?.value ? cleanText(info.extmetadata.ImageDescription.value, 2000) : undefined;
  const mime = info.mime ?? '';
  const categories = (info.extmetadata?.Categories?.value ?? '').split('|').filter(Boolean).slice(0, 10);
  let format: Discovered['format'];
  let media: Discovered['media'];
  if (mime.startsWith('image/')) {
    format = 'image';
    media = { url: info.thumburl ?? info.url, type: 'image', width: info.thumbwidth ?? info.width, height: info.thumbheight ?? info.height };
  } else if (mime.startsWith('video/')) {
    format = videoFormat(info.width, info.height);
    media = { url: info.url, type: 'video', width: info.width, height: info.height };
  } else if (mime.startsWith('audio/')) {
    format = 'audio';
    media = { url: info.url, type: 'audio' };
  } else return null;
  return {
    id: `url:${encodeURIComponent(info.descriptionurl)}`,
    title: title.slice(0, 300),
    description,
    format,
    tags: categories.map((category) => category.toLowerCase().replace(/\s+/g, '-')).slice(0, 10),
    publishedAt: toIso(info.timestamp),
    creator: info.user ? { id: `wikimedia:${info.user}`, name: info.user, url: `https://commons.wikimedia.org/wiki/User:${encodeURIComponent(info.user)}` } : undefined,
    thumbnailUrl: info.thumburl,
    media,
    pageUrl: info.descriptionurl,
    topics: inferTopics(`${title} ${description ?? ''}`, categories),
    adapter: 'wikimedia',
  };
}

async function commonsSearch(ctx: CrawlContext, config: WikimediaConfig, query: string): Promise<Discovered[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `${query} filetype:bitmap|drawing|video`,
    gsrnamespace: '6',
    gsrlimit: '20',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|user|timestamp|extmetadata',
    iiurlwidth: '960',
  });
  const data = (await ctx.fetcher.get(`${config.apiUrl}?${params}`, { accept: 'application/json' })).json<{
    query?: { pages?: Record<string, CommonsPage> };
  }>();
  return Object.values(data.query?.pages ?? {})
    .map(mapCommons)
    .filter((item): item is Discovered => Boolean(item));
}

export const wikimedia: Adapter<WikimediaConfig> = {
  id: 'wikimedia',
  label: 'Wikimedia Commons',
  description: 'Freely licensed photos, illustrations and videos.',
  defaults: { enabled: true, apiUrl: 'https://commons.wikimedia.org/w/api.php' },
  targets: (_config, queries) => queries.map((query) => `search:${query}`),
  discover: async (ctx, config, target) => ({ items: await commonsSearch(ctx, config, target.slice('search:'.length)) }),
  search: commonsSearch,
};

// ---------------------------------------------------------------------------
// Openverse: openly licensed images gathered from many sources.

export interface OpenverseConfig {
  enabled: boolean;
  apiUrl: string;
}

interface OpenverseImage {
  id?: string;
  title?: string;
  url?: string;
  thumbnail?: string;
  foreign_landing_url?: string;
  creator?: string;
  creator_url?: string;
  source?: string;
  width?: number;
  height?: number;
  tags?: { name: string }[];
  mature?: boolean;
}

export function mapOpenverse(image: OpenverseImage): Discovered | null {
  if (!image.url || !image.foreign_landing_url) return null;
  const tags = (image.tags ?? []).map((tag) => tag.name.toLowerCase()).slice(0, 15);
  const title = image.title?.trim() || tags.slice(0, 3).join(', ') || 'Image';
  return {
    id: `url:${encodeURIComponent(image.foreign_landing_url)}`,
    title: title.slice(0, 300),
    format: 'image',
    rating: image.mature ? 'nsfw' : undefined,
    tags,
    creator: image.creator ? { id: `${image.source ?? 'openverse'}:${image.creator}`.slice(0, 120), name: image.creator, url: image.creator_url } : undefined,
    thumbnailUrl: image.thumbnail,
    media: { url: image.url, type: 'image', width: image.width, height: image.height },
    pageUrl: image.foreign_landing_url,
    topics: inferTopics(title, tags),
    adapter: 'openverse',
  };
}

async function openverseSearch(ctx: CrawlContext, config: OpenverseConfig, query: string): Promise<Discovered[]> {
  const url = `${config.apiUrl.replace(/\/$/, '')}/images/?q=${encodeURIComponent(query)}&page_size=20&mature=false`;
  const data = (await ctx.fetcher.get(url, { accept: 'application/json' })).json<{ results?: OpenverseImage[] }>();
  return (data.results ?? []).map(mapOpenverse).filter((item): item is Discovered => Boolean(item));
}

export const openverse: Adapter<OpenverseConfig> = {
  id: 'openverse',
  label: 'Openverse',
  description: 'Openly licensed images from museums, Flickr, Wikimedia and more.',
  defaults: { enabled: true, apiUrl: 'https://api.openverse.org/v1' },
  targets: (_config, queries) => queries.map((query) => `search:${query}`),
  discover: async (ctx, config, target) => ({ items: await openverseSearch(ctx, config, target.slice('search:'.length)) }),
  search: openverseSearch,
};

// ---------------------------------------------------------------------------
// Flickr's public photo feed (by tags).

export interface FlickrConfig {
  enabled: boolean;
  feedUrl: string;
  tags: string[];
}

interface FlickrItem {
  title?: string;
  link?: string;
  media?: { m?: string };
  published?: string;
  author?: string;
  author_id?: string;
  tags?: string;
}

export function mapFlickr(item: FlickrItem): Discovered | null {
  if (!item.link || !item.media?.m) return null;
  const tags = (item.tags ?? '').split(/\s+/).filter(Boolean).slice(0, 15);
  const author = item.author?.match(/\("(.+)"\)/)?.[1] ?? item.author_id;
  const large = item.media.m.replace(/_m\.(jpg|png|gif)$/i, '_b.$1');
  const title = item.title?.trim() || tags.slice(0, 3).join(', ') || 'Photo';
  return {
    id: `url:${encodeURIComponent(item.link)}`,
    title: title.slice(0, 300),
    format: 'image',
    tags,
    publishedAt: toIso(item.published),
    creator: item.author_id ? { id: `flickr:${item.author_id}`, name: author ?? item.author_id, url: `https://www.flickr.com/photos/${item.author_id}/` } : undefined,
    thumbnailUrl: item.media.m,
    media: { url: large, type: 'image' },
    pageUrl: item.link,
    topics: inferTopics(title, tags),
    adapter: 'flickr',
  };
}

async function flickrTags(ctx: CrawlContext, config: FlickrConfig, tags: string): Promise<Discovered[]> {
  const url = `${config.feedUrl}?format=json&nojsoncallback=1&tagmode=all&tags=${encodeURIComponent(tags)}`;
  const data = (await ctx.fetcher.get(url, { accept: 'application/json' })).json<{ items?: FlickrItem[] }>();
  return (data.items ?? []).map(mapFlickr).filter((item): item is Discovered => Boolean(item));
}

const asTags = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .slice(0, 3)
    .join(',');

export const flickr: Adapter<FlickrConfig> = {
  id: 'flickr',
  label: 'Flickr',
  description: 'Recent public photos by tag.',
  defaults: {
    enabled: true,
    feedUrl: 'https://www.flickr.com/services/feeds/photos_public.gne',
    tags: ['landscape', 'nature', 'architecture', 'streetphotography', 'art'],
  },
  targets: (config, queries) => [...config.tags, ...queries.map(asTags)].filter(Boolean).map((tags) => `tags:${tags}`),
  discover: async (ctx, config, target) => ({ items: await flickrTags(ctx, config, target.slice('tags:'.length)) }),
  search: async (ctx, config, query) => (asTags(query) ? flickrTags(ctx, config, asTags(query)) : []),
};
