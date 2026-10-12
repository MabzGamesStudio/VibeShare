import { formatSource, sourceFromUrl } from '../../../shared/sources.js';
import { isoDuration, parseHtml, type PageInfo } from '../html.js';
import type { AdapterResult, CrawlContext, Discovered } from '../types.js';
import { inferTopics, toIso, videoFormat } from '../types.js';

export interface WebConfig {
  enabled: boolean;
  /** Pages to start from (blogs, galleries, link aggregators, video sites…). */
  seeds: string[];
  /** How many links away from a seed the crawler goes. */
  maxDepth: number;
  /** Stay on each seed's site (otherwise follow links anywhere, robots.txt permitting). */
  sameSite: boolean;
}

export const webDefaults: WebConfig = { enabled: true, seeds: [], maxDepth: 2, sameSite: true };

const NOT_PAGES = /\.(jpe?g|png|gif|webp|avif|svg|mp4|webm|mov|mp3|ogg|wav|flac|zip|gz|pdf|exe|dmg|apk|css|js|json|xml|ico)(\?|$)/i;

function num(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  if (value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') return (value as { url: string }).url;
  return undefined;
}

/** The content a page itself presents (a video page, a photo page), if any. */
export function pageContent(info: PageInfo): Discovered | null {
  const og = info.og;
  const video = info.jsonLd.find((item) => item['@type'] === 'VideoObject');
  const image = info.jsonLd.find((item) => item['@type'] === 'ImageObject');
  const page = info.canonical ?? og['og:url'] ?? info.url;
  const source = sourceFromUrl(page);
  if (!source) return null;
  const title = (str(video?.name) ?? og['og:title'] ?? info.title ?? '').trim();
  if (!title) return null;
  const description = str(video?.description) ?? og['og:description'] ?? info.description;
  const ogType = (og['og:type'] ?? '').toLowerCase();
  const videoUrl = og['og:video:secure_url'] ?? og['og:video:url'] ?? og['og:video'] ?? str(video?.contentUrl);
  const tags = (og['article:tag'] ? [og['article:tag']] : []).map((tag) => tag.toLowerCase());
  if (video || ogType.startsWith('video') || videoUrl) {
    const width = num(og['og:video:width']) ?? num(video?.width);
    const height = num(og['og:video:height']) ?? num(video?.height);
    const direct = videoUrl && /\.(mp4|webm|m4v|mov)(\?|$)/i.test(videoUrl) ? videoUrl : undefined;
    return {
      id: formatSource(source),
      title: title.slice(0, 300),
      description: description?.slice(0, 5000),
      format: videoFormat(width, height),
      durationSeconds: isoDuration(str(video?.duration)) ?? num(og['video:duration']),
      publishedAt: toIso(str(video?.uploadDate) ?? og['article:published_time']),
      thumbnailUrl: str(video?.thumbnailUrl) ?? og['og:image:secure_url'] ?? og['og:image'],
      media: direct ? { url: direct, type: 'video', width, height } : undefined,
      pageUrl: page,
      language: info.lang,
      tags,
      topics: inferTopics(`${title} ${description ?? ''}`, tags),
      adapter: 'web',
    };
  }
  if (image || ogType === 'photo' || ogType === 'image') {
    const url = str(image?.contentUrl) ?? og['og:image:secure_url'] ?? og['og:image'];
    if (!url) return null;
    return {
      id: formatSource(source),
      title: title.slice(0, 300),
      description: description?.slice(0, 5000),
      format: 'image',
      thumbnailUrl: url,
      media: { url, type: 'image', width: num(og['og:image:width']), height: num(og['og:image:height']) },
      pageUrl: page,
      language: info.lang,
      tags,
      topics: inferTopics(`${title} ${description ?? ''}`, tags),
      adapter: 'web',
    };
  }
  return null;
}

function sameSite(a: URL, b: URL): boolean {
  const strip = (host: string) => host.replace(/^www\./, '');
  return strip(a.hostname) === strip(b.hostname);
}

/** Fetches one page: what it presents, platform links to identify, and pages to visit next. */
export async function crawlPage(ctx: CrawlContext, config: WebConfig, url: string, depth: number, seed: string): Promise<AdapterResult & { identify: { url: string; title?: string }[] }> {
  const response = await ctx.fetcher.get(url, { accept: 'text/html,application/xhtml+xml', maxBytes: 3_000_000 });
  if (!/html/i.test(response.contentType)) return { items: [], links: [], identify: [] };
  const info = parseHtml(response.text(), response.url);
  const items: Discovered[] = [];
  const own = pageContent(info);
  if (own) items.push(own);
  const identify: { url: string; title?: string }[] = [];
  const links: { url: string; depth: number }[] = [];
  const base = new URL(response.url);
  const seedUrl = new URL(seed);
  for (const link of info.links) {
    const source = sourceFromUrl(link.href);
    if (source && source.scheme !== 'url' && source.scheme !== 'ipfs') {
      identify.push({ url: link.href, title: link.text || undefined });
      continue;
    }
    if (depth + 1 > config.maxDepth || NOT_PAGES.test(link.href)) continue;
    const target = new URL(link.href);
    if (config.sameSite && !sameSite(target, seedUrl) && !sameSite(target, base)) continue;
    links.push({ url: link.href, depth: depth + 1 });
  }
  return { items, links, identify };
}
