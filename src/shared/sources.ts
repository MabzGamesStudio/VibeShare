// Content ids and the external sources they can point to. Browser-safe: no Node imports.
//
// A content id tells the client where the content lives:
//
//   vs1<base32 sha256>                  native: a manifest served by content provider nodes
//   yt:dQw4w9WgXcQ                      external only: embedded from YouTube
//   vs1<hash>~yt:dQw4w9WgXcQ~ia:foo     native, falling back to YouTube, then the Internet Archive,
//                                       when no content provider has it
//
// Everything before the first `~` is the base id, which nodes index content by.

export const NATIVE_PREFIX = 'vs1';
export const CHUNK_PREFIX = 'vc1';

export type SourceScheme =
  | 'yt'
  | 'vimeo'
  | 'sc'
  | 'spotify'
  | 'tiktok'
  | 'x'
  | 'twitch'
  | 'ia'
  | 'peertube'
  | 'ipfs'
  | 'url';

export interface ExternalSource {
  scheme: SourceScheme;
  value: string;
}

export const SOURCE_LABELS: Record<SourceScheme, string> = {
  yt: 'YouTube',
  vimeo: 'Vimeo',
  sc: 'SoundCloud',
  spotify: 'Spotify',
  tiktok: 'TikTok',
  x: 'X (Twitter)',
  twitch: 'Twitch',
  ia: 'Internet Archive',
  peertube: 'PeerTube',
  ipfs: 'IPFS',
  url: 'Web link',
};

const SCHEMES = Object.keys(SOURCE_LABELS) as SourceScheme[];

export interface ParsedContentId {
  /** The full id as given, including fallbacks. */
  full: string;
  /** The id nodes index by: the native hash, or the first external source. */
  base: string;
  native: boolean;
  /** External sources to try, in order, when providers do not have the content (or for external-only ids). */
  sources: ExternalSource[];
}

const NATIVE_RE = /^vs1[a-z2-7]{52}$/;
const CHUNK_RE = /^vc1[a-z2-7]{52}$/;

export function isNativeId(id: string): boolean {
  return NATIVE_RE.test(id);
}

export function isChunkId(id: string): boolean {
  return CHUNK_RE.test(id);
}

export function formatSource(source: ExternalSource): string {
  return `${source.scheme}:${source.value}`;
}

export function parseSource(text: string): ExternalSource | null {
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const scheme = text.slice(0, colon) as SourceScheme;
  const value = text.slice(colon + 1);
  if (!SCHEMES.includes(scheme) || !value || value.length > 2048) return null;
  if (/[\s~]/.test(value)) return null;
  return { scheme, value };
}

export function parseContentId(text: string): ParsedContentId | null {
  const full = text.trim();
  if (!full || full.length > 4096) return null;
  const parts = full.split('~');
  const first = parts[0];
  const sources: ExternalSource[] = [];
  for (const part of parts.slice(1)) {
    const source = parseSource(part);
    if (!source) return null;
    sources.push(source);
  }
  if (isNativeId(first)) return { full, base: first, native: true, sources };
  const source = parseSource(first);
  if (!source) return null;
  return { full, base: first, native: false, sources: [source, ...sources] };
}

export function baseId(id: string): string {
  const tilde = id.indexOf('~');
  return tilde < 0 ? id : id.slice(0, tilde);
}

export function withSources(id: string, sources: ExternalSource[]): string {
  const parsed = parseContentId(id);
  if (!parsed) return id;
  const seen = new Set(parsed.sources.map(formatSource));
  const extra = sources.map(formatSource).filter((text) => !seen.has(text) && text !== parsed.base);
  return extra.length ? [parsed.full, ...extra].join('~') : parsed.full;
}

/** Turns a pasted link (YouTube, Vimeo, SoundCloud, Spotify, TikTok, X, Twitch, archive.org, PeerTube, IPFS, any URL) into a source. */
export function sourceFromUrl(input: string): ExternalSource | null {
  const text = input.trim();
  const direct = parseSource(text);
  if (direct && direct.scheme !== 'url' && !/^https?:/.test(text)) return direct;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'ipfs:') return { scheme: 'ipfs', value: url.hostname + url.pathname.replace(/\/$/, '') };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\.|^m\./, '');
  const path = url.pathname.split('/').filter(Boolean);
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v');
    if (v) return { scheme: 'yt', value: v };
    if ((path[0] === 'shorts' || path[0] === 'embed' || path[0] === 'live') && path[1]) return { scheme: 'yt', value: path[1] };
  }
  if (host === 'youtu.be' && path[0]) return { scheme: 'yt', value: path[0] };
  if (host === 'vimeo.com' && path.length && /^\d+$/.test(path[path.length - 1])) {
    return { scheme: 'vimeo', value: path[path.length - 1] };
  }
  if (host === 'player.vimeo.com' && path[0] === 'video' && path[1]) return { scheme: 'vimeo', value: path[1] };
  if (host === 'soundcloud.com' && path.length >= 2) return { scheme: 'sc', value: path.join('/') };
  if (host === 'open.spotify.com' && path.length >= 2) {
    const offset = path[0].startsWith('intl-') ? 1 : 0;
    return { scheme: 'spotify', value: `${path[offset]}:${path[offset + 1]}` };
  }
  if (host === 'tiktok.com') {
    const index = path.indexOf('video');
    if (index >= 0 && path[index + 1]) return { scheme: 'tiktok', value: path[index + 1] };
  }
  if ((host === 'x.com' || host === 'twitter.com') && path[1] === 'status' && path[2]) {
    return { scheme: 'x', value: path[2] };
  }
  if (host === 'twitch.tv' && path.length) {
    if (path[0] === 'videos' && path[1]) return { scheme: 'twitch', value: `v${path[1]}` };
    return { scheme: 'twitch', value: path[0] };
  }
  if (host === 'archive.org' && (path[0] === 'details' || path[0] === 'embed') && path[1]) {
    return { scheme: 'ia', value: path[1] };
  }
  if (path[0] === 'videos' && (path[1] === 'watch' || path[1] === 'embed') && path[2]) {
    return { scheme: 'peertube', value: `${url.host}/${path[2]}` };
  }
  if (path[0] === 'w' && path[1] && /^[A-Za-z0-9]{20,}$/.test(path[1])) {
    return { scheme: 'peertube', value: `${url.host}/${path[1]}` };
  }
  if (path[0] === 'ipfs' && path[1]) return { scheme: 'ipfs', value: path.slice(1).join('/') };
  const subdomain = url.hostname.match(/^([a-z0-9]{46,})\.ipfs\./);
  if (subdomain) return { scheme: 'ipfs', value: subdomain[1] + url.pathname.replace(/\/$/, '') };
  return { scheme: 'url', value: encodeURIComponent(url.toString()) };
}

export type EmbedKind = 'iframe' | 'video' | 'audio' | 'image' | 'link';

export interface Embed {
  kind: EmbedKind;
  /** What to load (iframe src, media src). */
  src: string;
  /** The page to open in a browser. */
  page: string;
  label: string;
}

const MEDIA_EXT: Record<string, EmbedKind> = {
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  ogv: 'video',
  mp3: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  wav: 'audio',
  flac: 'audio',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
};

function kindFromPath(path: string): EmbedKind | null {
  const ext = path.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_EXT[ext] ?? null;
}

/**
 * How the client shows an external source. `parentHost` is needed by Twitch, whose
 * player only loads inside pages it is told about.
 */
export function embedFor(source: ExternalSource, options: { ipfsGateway?: string; parentHost?: string } = {}): Embed {
  const label = SOURCE_LABELS[source.scheme];
  const value = source.value;
  const gateway = (options.ipfsGateway ?? 'https://ipfs.io').replace(/\/$/, '');
  switch (source.scheme) {
    case 'yt':
      return {
        kind: 'iframe',
        src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(value)}`,
        page: `https://www.youtube.com/watch?v=${encodeURIComponent(value)}`,
        label,
      };
    case 'vimeo':
      return {
        kind: 'iframe',
        src: `https://player.vimeo.com/video/${encodeURIComponent(value)}`,
        page: `https://vimeo.com/${encodeURIComponent(value)}`,
        label,
      };
    case 'sc': {
      const page = `https://soundcloud.com/${value}`;
      return { kind: 'iframe', src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(page)}`, page, label };
    }
    case 'spotify': {
      const [type, id] = value.split(':');
      return {
        kind: 'iframe',
        src: `https://open.spotify.com/embed/${type}/${id}`,
        page: `https://open.spotify.com/${type}/${id}`,
        label,
      };
    }
    case 'tiktok':
      return {
        kind: 'iframe',
        src: `https://www.tiktok.com/embed/v2/${encodeURIComponent(value)}`,
        page: `https://www.tiktok.com/video/${encodeURIComponent(value)}`,
        label,
      };
    case 'x':
      return {
        kind: 'iframe',
        src: `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(value)}`,
        page: `https://x.com/i/status/${encodeURIComponent(value)}`,
        label,
      };
    case 'twitch': {
      const parent = options.parentHost ?? 'localhost';
      const video = value.startsWith('v') && /^v\d+$/.test(value);
      return {
        kind: 'iframe',
        src: video
          ? `https://player.twitch.tv/?video=${value}&parent=${parent}`
          : `https://player.twitch.tv/?channel=${encodeURIComponent(value)}&parent=${parent}`,
        page: video ? `https://www.twitch.tv/videos/${value.slice(1)}` : `https://www.twitch.tv/${value}`,
        label,
      };
    }
    case 'ia':
      return {
        kind: 'iframe',
        src: `https://archive.org/embed/${encodeURIComponent(value)}`,
        page: `https://archive.org/details/${encodeURIComponent(value)}`,
        label,
      };
    case 'peertube': {
      const [host, ...rest] = value.split('/');
      const id = rest.join('/');
      return {
        kind: 'iframe',
        src: `https://${host}/videos/embed/${id}`,
        page: `https://${host}/w/${id}`,
        label,
      };
    }
    case 'ipfs': {
      const src = `${gateway}/ipfs/${value}`;
      return { kind: kindFromPath(value) ?? 'iframe', src, page: src, label };
    }
    case 'url': {
      let page = value;
      try {
        page = decodeURIComponent(value);
      } catch {
        // keep the raw value
      }
      if (!/^https?:\/\//.test(page)) return { kind: 'link', src: '', page: '', label };
      return { kind: kindFromPath(new URL(page).pathname) ?? 'link', src: page, page, label };
    }
  }
}
