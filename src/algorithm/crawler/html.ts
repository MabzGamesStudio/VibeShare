// Just enough HTML understanding for the crawler: page metadata (title, OpenGraph,
// Twitter cards, JSON-LD) and links. Regex based on purpose — no DOM, no scripts.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16) || 32);
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10) || 32);
    return ENTITIES[lower] ?? whole;
  });
}

/** Text of an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
export function cleanText(html: string, max = 5000): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, max);
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const match of tag.matchAll(re)) out[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  return out;
}

export interface PageInfo {
  url: string;
  title?: string;
  description?: string;
  canonical?: string;
  lang?: string;
  /** og:* properties (first value of each). */
  og: Record<string, string>;
  /** twitter:* properties. */
  twitter: Record<string, string>;
  /** Parsed JSON-LD objects (flattened @graph). */
  jsonLd: Record<string, unknown>[];
  links: { href: string; text: string }[];
}

export function parseHtml(html: string, pageUrl: string): PageInfo {
  const head = html.slice(0, 400_000);
  const info: PageInfo = { url: pageUrl, og: {}, twitter: {}, jsonLd: [], links: [] };
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) info.title = cleanText(title[1], 300);
  const lang = head.match(/<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]{2,10})/i);
  if (lang) info.lang = lang[1].toLowerCase().split('-')[0];
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    const content = attrs.content;
    if (!key || content === undefined) continue;
    if (key.startsWith('og:') && !(key in info.og)) info.og[key] = content;
    else if (key.startsWith('twitter:') && !(key in info.twitter)) info.twitter[key] = content;
    else if (key === 'description' && !info.description) info.description = content;
  }
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (attrs.rel?.toLowerCase() === 'canonical' && attrs.href) {
      try {
        info.canonical = new URL(attrs.href, pageUrl).toString();
      } catch {
        // ignore a broken canonical link
      }
    }
  }
  for (const match of head.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim()) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const graph = (item as { '@graph'?: unknown[] })['@graph'];
        if (Array.isArray(graph)) info.jsonLd.push(...(graph.filter((g) => g && typeof g === 'object') as Record<string, unknown>[]));
        else info.jsonLd.push(item as Record<string, unknown>);
      }
    } catch {
      // invalid JSON-LD is common; skip it
    }
  }
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attributes(`<a ${match[1]}>`).href;
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    resolved.hash = '';
    const key = resolved.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    info.links.push({ href: key, text: cleanText(match[2], 200) });
    if (info.links.length >= 1000) break;
  }
  return info;
}

/** ISO 8601 durations (PT1H2M3S) in seconds. */
export function isoDuration(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) return undefined;
  const [, d, h, m, s] = match;
  const total = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return Number.isFinite(total) ? total : undefined;
}
