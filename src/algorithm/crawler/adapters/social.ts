import { formatSource, sourceFromUrl } from '../../../shared/sources.js';
import { cleanText } from '../html.js';
import { formatForSource } from '../oembed.js';
import type { Adapter, AdapterResult, CrawlContext, Discovered } from '../types.js';
import { inferTopics, shorten, toIso, videoFormat } from '../types.js';

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?.*)?$/i;

// ---------------------------------------------------------------------------
// Mastodon (and compatible servers): public hashtag timelines with media.

export interface MastodonConfig {
  enabled: boolean;
  instances: string[];
  tags: string[];
}

interface MastodonStatus {
  id?: string;
  url?: string | null;
  uri?: string;
  created_at?: string;
  content?: string;
  sensitive?: boolean;
  language?: string | null;
  favourites_count?: number;
  account?: { acct?: string; username?: string; display_name?: string; url?: string };
  media_attachments?: {
    type?: string;
    url?: string;
    preview_url?: string;
    description?: string | null;
    meta?: { original?: { width?: number; height?: number; duration?: number } };
  }[];
  tags?: { name: string }[];
  reblog?: MastodonStatus | null;
}

export function mapMastodon(raw: MastodonStatus, origin: string): Discovered | null {
  const status = raw.reblog ?? raw;
  const attachment = status.media_attachments?.find((media) => ['image', 'video', 'gifv'].includes(media.type ?? ''));
  const page = status.url ?? status.uri;
  if (!attachment?.url || !page) return null;
  const source = sourceFromUrl(page);
  if (!source) return null;
  const text = cleanText(status.content ?? '', 2000);
  const tags = (status.tags ?? []).map((tag) => tag.name.toLowerCase()).slice(0, 15);
  const meta = attachment.meta?.original;
  const isImage = attachment.type === 'image';
  const host = new URL(origin).host;
  const acct = status.account?.acct ?? status.account?.username ?? 'unknown';
  return {
    id: formatSource(source),
    title: shorten(text || attachment.description || `Post by ${status.account?.display_name || acct}`, 140),
    description: text || undefined,
    format: isImage ? 'image' : videoFormat(meta?.width, meta?.height),
    rating: status.sensitive ? 'nsfw' : undefined,
    tags,
    language: status.language ?? undefined,
    durationSeconds: meta?.duration,
    publishedAt: toIso(status.created_at),
    creator: { id: `mastodon:${acct.includes('@') ? acct : `${acct}@${host}`}`, name: status.account?.display_name || acct, url: status.account?.url },
    thumbnailUrl: attachment.preview_url,
    media: { url: attachment.url, type: isImage ? 'image' : 'video', width: meta?.width, height: meta?.height },
    pageUrl: page,
    stats: { likes: status.favourites_count },
    topics: inferTopics(text, tags),
    adapter: 'mastodon',
  };
}

async function mastodonTag(ctx: CrawlContext, origin: string, tag: string): Promise<Discovered[]> {
  const statuses = (
    await ctx.fetcher.get(`${origin}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=30&only_media=true`, { accept: 'application/json' })
  ).json<MastodonStatus[]>();
  return (Array.isArray(statuses) ? statuses : []).map((status) => mapMastodon(status, origin)).filter((item): item is Discovered => Boolean(item));
}

const hashtag = (query: string) => query.replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '');

export const mastodon: Adapter<MastodonConfig> = {
  id: 'mastodon',
  label: 'Mastodon',
  description: 'Photos and videos posted under hashtags on Mastodon servers.',
  defaults: {
    enabled: true,
    instances: ['https://mastodon.social'],
    tags: ['photography', 'art', 'nature', 'video', 'music'],
  },
  targets: (config, queries) =>
    config.instances.flatMap((instance) =>
      [...config.tags, ...queries.map(hashtag)].filter(Boolean).map((tag) => `${instance.replace(/\/$/, '')}#${tag}`)
    ),
  async discover(ctx, _config, target) {
    const [origin, tag] = target.split('#');
    return { items: await mastodonTag(ctx, origin, tag) };
  },
  async search(ctx, config, query) {
    const tag = hashtag(query);
    if (!tag || !config.instances[0]) return [];
    return mastodonTag(ctx, config.instances[0].replace(/\/$/, ''), tag);
  },
};

// ---------------------------------------------------------------------------
// Bluesky: posts with images or video, through the public AppView API.

export interface BlueskyConfig {
  enabled: boolean;
  apiUrl: string;
}

interface BlueskyImage {
  thumb?: string;
  fullsize?: string;
  alt?: string;
  aspectRatio?: { width: number; height: number };
}

interface BlueskyEmbed {
  $type?: string;
  images?: BlueskyImage[];
  thumbnail?: string;
  playlist?: string;
  aspectRatio?: { width: number; height: number };
  external?: { uri?: string; title?: string; thumb?: string };
  media?: BlueskyEmbed;
}

interface BlueskyPost {
  uri?: string;
  author?: { did?: string; handle?: string; displayName?: string };
  record?: { text?: string; createdAt?: string; langs?: string[] };
  embed?: BlueskyEmbed;
  likeCount?: number;
  labels?: { val: string }[];
}

const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore']);

export function mapBluesky(post: BlueskyPost): { item?: Discovered; link?: string } {
  const did = post.author?.did;
  const rkey = post.uri?.split('/').pop();
  if (!did || !rkey) return {};
  let embed = post.embed;
  if (embed?.$type?.startsWith('app.bsky.embed.recordWithMedia') && embed.media) embed = embed.media;
  if (embed?.$type?.startsWith('app.bsky.embed.external') && embed.external?.uri) return { link: embed.external.uri };
  const image = embed?.images?.[0];
  const isVideo = Boolean(embed?.$type?.startsWith('app.bsky.embed.video'));
  if (!image && !isVideo) return {};
  const text = post.record?.text ?? '';
  const ratio = (image?.aspectRatio ?? embed?.aspectRatio) as { width: number; height: number } | undefined;
  const handle = post.author?.handle ?? did;
  return {
    item: {
      id: `bsky:${did}/${rkey}`,
      title: shorten(text || image?.alt || `Post by ${post.author?.displayName || handle}`, 140),
      description: text || undefined,
      format: isVideo ? videoFormat(ratio?.width, ratio?.height) : 'image',
      rating: post.labels?.some((label) => ADULT_LABELS.has(label.val)) ? 'nsfw' : undefined,
      language: post.record?.langs?.[0],
      publishedAt: toIso(post.record?.createdAt),
      creator: { id: `bluesky:${handle}`, name: post.author?.displayName || handle, url: `https://bsky.app/profile/${handle}` },
      thumbnailUrl: image?.thumb ?? embed?.thumbnail,
      media: image?.fullsize ? { url: image.fullsize, type: 'image', width: ratio?.width, height: ratio?.height } : undefined,
      pageUrl: `https://bsky.app/profile/${handle}/post/${rkey}`,
      stats: { likes: post.likeCount },
      topics: inferTopics(text),
      adapter: 'bluesky',
    },
  };
}

async function blueskySearch(ctx: CrawlContext, config: BlueskyConfig, query: string, sort: 'top' | 'latest'): Promise<AdapterResult> {
  const url = `${config.apiUrl.replace(/\/$/, '')}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=30&sort=${sort}`;
  const data = (await ctx.fetcher.get(url, { accept: 'application/json' })).json<{ posts?: BlueskyPost[] }>();
  const items: Discovered[] = [];
  const links: { url: string }[] = [];
  for (const post of data.posts ?? []) {
    const mapped = mapBluesky(post);
    if (mapped.item) items.push(mapped.item);
    if (mapped.link) links.push({ url: mapped.link });
  }
  return { items, links };
}

export const bluesky: Adapter<BlueskyConfig> = {
  id: 'bluesky',
  label: 'Bluesky',
  description: 'Images and videos posted on Bluesky, and the links people share there.',
  defaults: { enabled: true, apiUrl: 'https://public.api.bsky.app' },
  targets: (_config, queries) => queries.map((query) => `search:${query}`),
  discover: (ctx, config, target) => blueskySearch(ctx, config, target.slice('search:'.length), 'top'),
  search: async (ctx, config, query) => (await blueskySearch(ctx, config, query, 'top')).items,
};

// ---------------------------------------------------------------------------
// Lemmy: link aggregation. Posts of images and of video platforms become entries.

export interface LemmyConfig {
  enabled: boolean;
  instances: string[];
}

interface LemmyView {
  post?: {
    id?: number;
    name?: string;
    url?: string | null;
    body?: string | null;
    thumbnail_url?: string | null;
    nsfw?: boolean;
    published?: string;
    url_content_type?: string | null;
    ap_id?: string;
  };
  creator?: { name?: string; display_name?: string | null; actor_id?: string };
  community?: { name?: string; title?: string };
  counts?: { score?: number; upvotes?: number };
}

export function mapLemmy(view: LemmyView): Discovered | null {
  const post = view.post;
  if (!post?.url || !post.name) return null;
  const source = sourceFromUrl(post.url);
  if (!source) return null;
  const isImage = (post.url_content_type ?? '').startsWith('image/') || IMAGE_EXT.test(post.url);
  const platformLink = source.scheme !== 'url' && source.scheme !== 'ipfs';
  if (!isImage && !platformLink) return null; // articles and other links stay out
  const community = view.community?.name;
  const tags = community ? [community.toLowerCase()] : [];
  const creatorName = view.creator?.display_name || view.creator?.name;
  return {
    id: formatSource(source),
    title: post.name.slice(0, 300),
    description: post.body ? cleanText(post.body, 2000) : undefined,
    format: isImage ? 'image' : formatForSource(source, post.url),
    rating: post.nsfw ? 'nsfw' : undefined,
    tags,
    publishedAt: toIso(post.published),
    creator: platformLink ? undefined : view.creator?.actor_id ? { id: `lemmy:${view.creator.actor_id}`, name: creatorName ?? 'unknown', url: view.creator.actor_id } : undefined,
    thumbnailUrl: post.thumbnail_url ?? undefined,
    media: isImage ? { url: post.url, type: 'image' } : undefined,
    pageUrl: platformLink ? post.url : (post.ap_id ?? post.url),
    stats: { likes: view.counts?.upvotes ?? view.counts?.score },
    topics: inferTopics(post.name, tags),
    adapter: 'lemmy',
  };
}

async function lemmyPosts(ctx: CrawlContext, url: string): Promise<Discovered[]> {
  const data = (await ctx.fetcher.get(url, { accept: 'application/json' })).json<{ posts?: LemmyView[] }>();
  return (data.posts ?? []).map(mapLemmy).filter((item): item is Discovered => Boolean(item));
}

export const lemmy: Adapter<LemmyConfig> = {
  id: 'lemmy',
  label: 'Lemmy',
  description: 'Popular image posts and video links on Lemmy instances.',
  defaults: { enabled: true, instances: ['https://lemmy.world'] },
  targets: (config) => config.instances.map((instance) => `hot:${instance.replace(/\/$/, '')}`),
  discover: async (ctx, _config, target) => ({ items: await lemmyPosts(ctx, `${target.slice(4)}/api/v3/post/list?type_=All&sort=Hot&limit=30`) }),
  async search(ctx, config, query) {
    const instance = config.instances[0]?.replace(/\/$/, '');
    if (!instance) return [];
    return lemmyPosts(ctx, `${instance}/api/v3/search?q=${encodeURIComponent(query)}&type_=Posts&sort=TopAll&limit=20`);
  },
};
