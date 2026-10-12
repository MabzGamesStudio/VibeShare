import { decodeEntities, cleanText } from '../html.js';
import type { Adapter, CrawlContext, Discovered } from '../types.js';
import { inferTopics, toIso, videoFormat } from '../types.js';
import type { Format } from '../../../shared/taxonomy.js';

// ---------------------------------------------------------------------------
// YouTube: channel Atom feeds (no key needed); search through the Data API v3 when the
// operator configures an API key (YouTube's own search pages are not for crawlers).

export interface YouTubeConfig {
  enabled: boolean;
  /** Channel ids (UC…) whose new uploads are followed. */
  channels: string[];
  /** YouTube Data API key, for searches. */
  apiKey: string;
  siteUrl: string;
  apiUrl: string;
}

function tag(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match ? decodeEntities(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : undefined;
}

function attr(xml: string, name: string, attribute: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}\\b[^>]*\\b${attribute}="([^"]*)"`));
  return match ? decodeEntities(match[1]) : undefined;
}

export function parseYouTubeFeed(xml: string): Discovered[] {
  const items: Discovered[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1];
    const id = tag(entry, 'yt:videoId');
    const title = tag(entry, 'title') ?? tag(entry, 'media:title');
    if (!id || !title) continue;
    const link = attr(entry, 'link', 'href') ?? `https://www.youtube.com/watch?v=${id}`;
    const channelId = tag(entry, 'yt:channelId');
    const author = tag(entry, 'name');
    const description = tag(entry, 'media:description');
    const views = Number(attr(entry, 'media:statistics', 'views'));
    const likes = Number(attr(entry, 'media:starRating', 'count'));
    items.push({
      id: `yt:${id}`,
      title: title.slice(0, 300),
      description: description?.slice(0, 5000),
      format: link.includes('/shorts/') ? 'short-video' : 'video',
      publishedAt: toIso(tag(entry, 'published')),
      creator: channelId ? { id: `youtube:${channelId}`, name: author ?? channelId, url: `https://www.youtube.com/channel/${channelId}` } : undefined,
      thumbnailUrl: attr(entry, 'media:thumbnail', 'url'),
      pageUrl: link,
      stats: { views: Number.isFinite(views) ? views : undefined, likes: Number.isFinite(likes) ? likes : undefined },
      topics: inferTopics(`${title} ${description ?? ''}`),
      adapter: 'youtube',
    });
  }
  return items;
}

export const youtube: Adapter<YouTubeConfig> = {
  id: 'youtube',
  label: 'YouTube',
  description: 'New uploads of followed channels (RSS); searches with a YouTube Data API key.',
  defaults: {
    enabled: true,
    channels: [
      'UCLA_DiR1FfKNvjuUpBHmylQ', // NASA
      'UCsXVk37bltHxD1rDPwtNM8Q', // Kurzgesagt
      'UCsooa4yRKGN_zEE8iknghZA', // TED-Ed
      'UCSMOQeBJ2RAnuFungnQOxLg', // Blender
      'UCHnyfMqiRRG1u-2MsSQLbXA', // Veritasium
    ],
    apiKey: '',
    siteUrl: 'https://www.youtube.com',
    apiUrl: 'https://www.googleapis.com/youtube/v3',
  },
  targets: (config) => config.channels.map((channel) => `channel:${channel}`),
  async discover(ctx, config, target) {
    const channel = target.slice('channel:'.length);
    const response = await ctx.fetcher.get(`${config.siteUrl}/feeds/videos.xml?channel_id=${encodeURIComponent(channel)}`, {
      accept: 'application/atom+xml,application/xml',
    });
    return { items: parseYouTubeFeed(response.text()) };
  },
  async search(ctx, config, query) {
    if (!config.apiKey) return [];
    const url = `${config.apiUrl}/search?part=snippet&type=video&maxResults=15&q=${encodeURIComponent(query)}&key=${encodeURIComponent(config.apiKey)}`;
    const data = (await ctx.fetcher.get(url, { accept: 'application/json' })).json<{
      items?: {
        id?: { videoId?: string };
        snippet?: {
          title?: string;
          description?: string;
          channelId?: string;
          channelTitle?: string;
          publishedAt?: string;
          thumbnails?: Record<string, { url: string }>;
        };
      }[];
    }>();
    return (data.items ?? []).flatMap((item): Discovered[] => {
      const id = item.id?.videoId;
      const snippet = item.snippet;
      if (!id || !snippet?.title) return [];
      const title = decodeEntities(snippet.title);
      return [
        {
          id: `yt:${id}`,
          title,
          description: snippet.description,
          format: 'video',
          publishedAt: toIso(snippet.publishedAt),
          creator: snippet.channelId ? { id: `youtube:${snippet.channelId}`, name: snippet.channelTitle ?? snippet.channelId } : undefined,
          thumbnailUrl: snippet.thumbnails?.high?.url ?? snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url,
          pageUrl: `https://www.youtube.com/watch?v=${id}`,
          topics: inferTopics(`${title} ${snippet.description ?? ''}`),
          adapter: 'youtube',
        },
      ];
    });
  },
};

// ---------------------------------------------------------------------------
// PeerTube: the federated video network. Instances' public API and SepiaSearch, the
// search index across PeerTube instances.

export interface PeerTubeConfig {
  enabled: boolean;
  instances: string[];
  /** A peertube-search-index (SepiaSearch) to search the whole federation; empty to skip. */
  searchIndex: string;
}

interface PeerTubeVideo {
  uuid?: string;
  shortUUID?: string;
  name?: string;
  description?: string | null;
  duration?: number;
  url?: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  previewPath?: string;
  publishedAt?: string;
  views?: number;
  likes?: number;
  nsfw?: boolean;
  isLive?: boolean;
  aspectRatio?: number | null;
  tags?: string[];
  language?: { id?: string | null };
  account?: { name?: string; displayName?: string; host?: string; url?: string };
  channel?: { name?: string; displayName?: string; host?: string; url?: string };
}

export function mapPeerTube(video: PeerTubeVideo, queriedOrigin: string): Discovered | null {
  const key = video.shortUUID ?? video.uuid;
  if (!key || !video.name) return null;
  let host = video.channel?.host ?? video.account?.host;
  if (!host && video.url) host = new URL(video.url).host;
  host ??= new URL(queriedOrigin).host;
  const format: Format = video.isLive ? 'live' : videoFormat(undefined, undefined, video.aspectRatio ?? undefined);
  const owner = video.channel ?? video.account;
  const description = video.description ?? undefined;
  return {
    id: `peertube:${host}/${key}`,
    title: video.name.slice(0, 300),
    description: description?.slice(0, 5000),
    format,
    rating: video.nsfw ? 'nsfw' : undefined,
    tags: video.tags,
    language: video.language?.id ?? undefined,
    durationSeconds: video.duration,
    publishedAt: toIso(video.publishedAt),
    creator: owner?.name ? { id: `peertube:${owner.name}@${owner.host ?? host}`, name: owner.displayName || owner.name, url: owner.url } : undefined,
    thumbnailUrl: video.thumbnailUrl ?? (video.thumbnailPath ? `${queriedOrigin}${video.thumbnailPath}` : undefined),
    pageUrl: video.url ?? `https://${host}/w/${key}`,
    stats: { views: video.views, likes: video.likes },
    topics: inferTopics(`${video.name} ${description ?? ''}`, video.tags),
    adapter: 'peertube',
  };
}

async function peertubeList(ctx: CrawlContext, origin: string, path: string): Promise<Discovered[]> {
  const data = (await ctx.fetcher.get(`${origin}${path}`, { accept: 'application/json' })).json<{ data?: PeerTubeVideo[] }>();
  return (data.data ?? []).map((video) => mapPeerTube(video, origin)).filter((item): item is Discovered => Boolean(item));
}

export const peertube: Adapter<PeerTubeConfig> = {
  id: 'peertube',
  label: 'PeerTube',
  description: 'Recent videos of PeerTube instances, and the federation-wide SepiaSearch index.',
  defaults: { enabled: true, instances: ['https://framatube.org', 'https://tilvids.com'], searchIndex: 'https://sepiasearch.org' },
  targets: (config, queries) => [
    ...config.instances.map((instance) => `instance:${instance.replace(/\/$/, '')}`),
    ...(config.searchIndex ? queries.map((query) => `search:${query}`) : []),
  ],
  async discover(ctx, config, target) {
    if (target.startsWith('instance:')) {
      return { items: await peertubeList(ctx, target.slice('instance:'.length), '/api/v1/videos?sort=-publishedAt&count=25') };
    }
    const query = target.slice('search:'.length);
    const index = config.searchIndex.replace(/\/$/, '');
    return { items: await peertubeList(ctx, index, `/api/v1/search/videos?search=${encodeURIComponent(query)}&count=25&sort=-publishedAt`) };
  },
  async search(ctx, config, query) {
    const index = config.searchIndex.replace(/\/$/, '') || config.instances[0]?.replace(/\/$/, '');
    if (!index) return [];
    return peertubeList(ctx, index, `/api/v1/search/videos?search=${encodeURIComponent(query)}&count=20&sort=-match`);
  },
};

// ---------------------------------------------------------------------------
// Dailymotion's public REST API.

export interface DailymotionConfig {
  enabled: boolean;
  apiUrl: string;
}

const DM_FIELDS = 'id,title,description,thumbnail_480_url,owner.id,owner.screenname,duration,created_time,aspect_ratio,views_total,likes_total,explicit,tags,language';

interface DailymotionVideo {
  id?: string;
  title?: string;
  description?: string;
  thumbnail_480_url?: string;
  'owner.id'?: string;
  'owner.screenname'?: string;
  duration?: number;
  created_time?: number;
  aspect_ratio?: number;
  views_total?: number;
  likes_total?: number;
  explicit?: boolean;
  tags?: string[];
  language?: string;
}

export function mapDailymotion(video: DailymotionVideo): Discovered | null {
  if (!video.id || !video.title) return null;
  const description = video.description ? cleanText(video.description) : undefined;
  return {
    id: `dm:${video.id}`,
    title: video.title.slice(0, 300),
    description,
    format: videoFormat(undefined, undefined, video.aspect_ratio),
    rating: video.explicit ? 'nsfw' : undefined,
    tags: video.tags?.slice(0, 20),
    language: video.language,
    durationSeconds: video.duration,
    publishedAt: toIso(video.created_time),
    creator: video['owner.id']
      ? { id: `dailymotion:${video['owner.id']}`, name: video['owner.screenname'] ?? video['owner.id'], url: `https://www.dailymotion.com/${video['owner.screenname'] ?? ''}` }
      : undefined,
    thumbnailUrl: video.thumbnail_480_url,
    pageUrl: `https://www.dailymotion.com/video/${video.id}`,
    stats: { views: video.views_total, likes: video.likes_total },
    topics: inferTopics(`${video.title} ${description ?? ''}`, video.tags),
    adapter: 'dailymotion',
  };
}

async function dailymotionList(ctx: CrawlContext, config: DailymotionConfig, params: string): Promise<Discovered[]> {
  const url = `${config.apiUrl.replace(/\/$/, '')}/videos?fields=${DM_FIELDS}&limit=25&${params}`;
  const data = (await ctx.fetcher.get(url, { accept: 'application/json' })).json<{ list?: DailymotionVideo[] }>();
  return (data.list ?? []).map(mapDailymotion).filter((item): item is Discovered => Boolean(item));
}

export const dailymotion: Adapter<DailymotionConfig> = {
  id: 'dailymotion',
  label: 'Dailymotion',
  description: 'Trending and topical videos through the public Dailymotion API.',
  defaults: { enabled: true, apiUrl: 'https://api.dailymotion.com' },
  targets: (_config, queries) => ['trending', ...queries.map((query) => `search:${query}`)],
  async discover(ctx, config, target) {
    if (target === 'trending') return { items: await dailymotionList(ctx, config, 'sort=trending') };
    return { items: await dailymotionList(ctx, config, `sort=recent&search=${encodeURIComponent(target.slice(7))}`) };
  },
  search: (ctx, config, query) => dailymotionList(ctx, config, `sort=relevance&search=${encodeURIComponent(query)}`),
};

// ---------------------------------------------------------------------------
// The Internet Archive's advanced search.

export interface ArchiveConfig {
  enabled: boolean;
  apiUrl: string;
}

interface ArchiveDoc {
  identifier?: string;
  title?: string | string[];
  creator?: string | string[];
  mediatype?: string;
  publicdate?: string;
  description?: string | string[];
  subject?: string | string[];
  downloads?: number;
  collection?: string | string[];
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const list = (value: string | string[] | undefined) => (Array.isArray(value) ? value : value ? value.split(/[;,]\s*/) : []);

export function mapArchive(doc: ArchiveDoc, apiUrl: string): Discovered | null {
  const identifier = doc.identifier;
  const title = first(doc.title);
  if (!identifier || !title) return null;
  const collections = list(doc.collection);
  const format: Format | null =
    doc.mediatype === 'movies'
      ? 'video'
      : doc.mediatype === 'audio' || doc.mediatype === 'etree'
        ? collections.some((c) => /etree|music|78rpm|audio_music/i.test(c))
          ? 'music'
          : 'audio'
        : doc.mediatype === 'image'
          ? 'image'
          : doc.mediatype === 'texts'
            ? 'book'
            : null;
  if (!format) return null;
  const description = first(doc.description);
  const creator = first(doc.creator);
  const tags = list(doc.subject).slice(0, 15);
  const base = apiUrl.replace(/\/$/, '');
  return {
    id: `ia:${identifier}`,
    title: title.slice(0, 300),
    description: description ? cleanText(description) : undefined,
    format,
    tags,
    publishedAt: toIso(doc.publicdate),
    creator: creator ? { id: `archive:${creator.toLowerCase().slice(0, 80)}`, name: creator.slice(0, 120) } : undefined,
    thumbnailUrl: `${base}/services/img/${encodeURIComponent(identifier)}`,
    pageUrl: `${base}/details/${encodeURIComponent(identifier)}`,
    stats: { views: doc.downloads },
    topics: inferTopics(`${title} ${description ?? ''}`, tags),
    adapter: 'archive',
  };
}

async function archiveSearch(ctx: CrawlContext, config: ArchiveConfig, q: string, sort: string): Promise<Discovered[]> {
  const fields = ['identifier', 'title', 'creator', 'mediatype', 'publicdate', 'description', 'subject', 'downloads', 'collection'];
  const params = [
    `q=${encodeURIComponent(q)}`,
    ...fields.map((field) => `fl%5B%5D=${field}`),
    `sort%5B%5D=${encodeURIComponent(sort)}`,
    'rows=25',
    'page=1',
    'output=json',
  ].join('&');
  const data = (await ctx.fetcher.get(`${config.apiUrl.replace(/\/$/, '')}/advancedsearch.php?${params}`, { accept: 'application/json' })).json<{
    response?: { docs?: ArchiveDoc[] };
  }>();
  return (data.response?.docs ?? []).map((doc) => mapArchive(doc, config.apiUrl)).filter((item): item is Discovered => Boolean(item));
}

const MEDIA = 'mediatype:(movies OR audio OR image)';

export const archive: Adapter<ArchiveConfig> = {
  id: 'archive',
  label: 'Internet Archive',
  description: 'Films, recordings and images from archive.org.',
  defaults: { enabled: true, apiUrl: 'https://archive.org' },
  targets: (_config, queries) => ['recent', ...queries.map((query) => `search:${query}`)],
  async discover(ctx, config, target) {
    if (target === 'recent') return { items: await archiveSearch(ctx, config, MEDIA, 'publicdate desc') };
    const query = target.slice('search:'.length).replace(/[():"]/g, ' ');
    return { items: await archiveSearch(ctx, config, `(${query}) AND ${MEDIA}`, 'downloads desc') };
  },
  search: (ctx, config, query) => archiveSearch(ctx, config, `(${query.replace(/[():"]/g, ' ')}) AND ${MEDIA}`, 'downloads desc'),
};

