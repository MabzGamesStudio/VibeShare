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
//
// The schemes a source can use (`yt`, `peertube`, `lemmy`…) are an open registry:
// every scheme knows its own label, how it recognizes its URLs, and how to embed or
// page it (see SourceSchemeDef). The built-ins below cover the platforms VibeShare
// ships with; a fork adds its own with registerSourceScheme().

export const NATIVE_PREFIX = 'vs1';
export const CHUNK_PREFIX = 'vc1';

const KNOWN_SOURCE_SCHEMES = [
  'yt',
  'vimeo',
  'dm',
  'sc',
  'spotify',
  'tiktok',
  'ig',
  'x',
  'bsky',
  'masto',
  'twitch',
  'ia',
  'peertube',
  'ipfs',
  'url',
] as const;

/** The source schemes this build ships; registered schemes may add more (see SourceScheme). */
export type KnownSourceScheme = (typeof KNOWN_SOURCE_SCHEMES)[number];

/** A source scheme: one of the built-ins, or any scheme a fork registered. */
export type SourceScheme = KnownSourceScheme | (string & {});

export interface ExternalSource {
  scheme: SourceScheme;
  value: string;
}

/**
 * The one contract every source of external content implements: it recognizes its
 * own URLs and turns them into the canonical source id (`yt:dQw4w9WgXcQ`). The
 * crawler's platform adapters and the client's URL handling both speak it.
 */
export interface SourceAdapter {
  /** Stable id: the scheme or platform key this adapter works with. */
  id: string;
  label: string;
  /** Whether this URL belongs to the source. */
  match(url: URL): boolean;
  /** The canonical source a recognized URL points at, or null. */
  parse(url: URL): ExternalSource | null;
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

export interface EmbedOptions {
  ipfsGateway?: string;
  /** Needed by Twitch, whose player only loads inside pages it is told about. */
  parentHost?: string;
  /** Start playing on load (players need `muted` for that in most browsers). */
  autoplay?: boolean;
  muted?: boolean;
  loop?: boolean;
}

/** How one scheme recognizes, embeds and pages its sources. */
export interface SourceSchemeDef extends SourceAdapter {
  /** The scheme as it appears in a content id (`yt:value`). */
  id: SourceScheme;
  /** The kind of embed this scheme shows before a link is inspected. */
  media: EmbedKind;
  /** The page to open in a browser for a source value. */
  pageFor(value: string, options: EmbedOptions): string;
  /** The embed (or media) to show for a source value. */
  embedFor(value: string, options: EmbedOptions): { kind: EmbedKind; src: string };
  /** A still image the scheme serves directly for a value, when it has one. */
  imageFor?(value: string): string | undefined;
  /** The generic web-link catch-all: matched only after every other scheme. */
  fallback?: boolean;
}

const SOURCE_SCHEMES: SourceSchemeDef[] = [];

/**
 * Registers a source scheme (or replaces one of the same id), so a fork can add a
 * platform without touching the parser or the embed builders. `match` may be left
 * out: it then means "parse recognizes the URL".
 */
export function registerSourceScheme(def: Omit<SourceSchemeDef, 'match'> & { match?: SourceAdapter['match'] }): void {
  const id = String(def.id ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`Not a source scheme id: ${def.id}`);
  const full: SourceSchemeDef = { ...def, id, match: def.match ?? ((url) => def.parse(url) !== null) };
  const at = SOURCE_SCHEMES.findIndex((scheme) => scheme.id === id);
  if (at >= 0) SOURCE_SCHEMES[at] = full;
  else SOURCE_SCHEMES.push(full);
}

/** Every registered scheme, in registration order (built-ins first, catch-all last). */
export function sourceSchemes(): SourceSchemeDef[] {
  return [...SOURCE_SCHEMES];
}

/** The registered scheme of an id, if there is one. */
export function sourceSchemeOf(id: string): SourceSchemeDef | undefined {
  return SOURCE_SCHEMES.find((scheme) => scheme.id === String(id ?? '').toLowerCase());
}

/** The label of a scheme id ("YouTube"), if the scheme is registered. */
export function sourceSchemeLabel(id: string): string | undefined {
  return sourceSchemeOf(id)?.label;
}

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
  const scheme = text.slice(0, colon);
  const value = text.slice(colon + 1);
  // Schemes match exactly as written (all ids are lower case), as they always have.
  if (!sourceSchemeOf(scheme) || scheme !== scheme.toLowerCase() || !value || value.length > 2048) return null;
  if (/[\s~]/.test(value) || value.startsWith('/')) return null;
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
  const seen = new Set([parsed.base, ...parsed.sources.map(formatSource)]);
  const extra: string[] = [];
  for (const text of sources.map(formatSource)) {
    if (seen.has(text)) continue;
    seen.add(text);
    extra.push(text);
  }
  return extra.length ? [parsed.full, ...extra].join('~') : parsed.full;
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

function query(params: Record<string, string | false | undefined>): string {
  const pairs = Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return pairs.length ? `?${pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}` : '';
}

/** The host a URL check compares against: without its www. or m. prefix. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^www\.|^m\./, '');
}

function pathOf(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

// -------------------------------------------------------------------------
// The built-in schemes. Each recognizes its own URLs and knows how to embed and
// page its sources; `url` is the generic web-link catch-all and always matches last.

registerSourceScheme({
  id: 'yt',
  label: 'YouTube',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      const v = url.searchParams.get('v');
      if (v) return { scheme: 'yt', value: v };
      if ((path[0] === 'shorts' || path[0] === 'embed' || path[0] === 'live') && path[1]) return { scheme: 'yt', value: path[1] };
    }
    if (host === 'youtu.be' && path[0]) return { scheme: 'yt', value: path[0] };
    return null;
  },
  pageFor: (value) => `https://www.youtube.com/watch?v=${encodeURIComponent(value)}`,
  embedFor(value, options) {
    const id = encodeURIComponent(value);
    return {
      kind: 'iframe',
      src: `https://www.youtube-nocookie.com/embed/${id}${query({
        autoplay: options.autoplay ? '1' : undefined,
        mute: options.autoplay || options.muted ? (options.muted === false ? undefined : '1') : undefined,
        playsinline: options.autoplay ? '1' : undefined,
        loop: options.loop ? '1' : undefined,
        playlist: options.loop ? value : undefined,
        rel: options.autoplay ? '0' : undefined,
        // Lets the page pause, play and unmute the player by message.
        enablejsapi: options.autoplay ? '1' : undefined,
      })}`,
    };
  },
});

registerSourceScheme({
  id: 'dm',
  label: 'Dailymotion',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'dailymotion.com' && (path[0] === 'video' || path[0] === 'embed') && path[path.length - 1]) {
      return { scheme: 'dm', value: path[path.length - 1].split('_')[0] };
    }
    if (host === 'dai.ly' && path[0]) return { scheme: 'dm', value: path[0] };
    return null;
  },
  pageFor: (value) => `https://www.dailymotion.com/video/${encodeURIComponent(value)}`,
  embedFor(value, options) {
    return {
      kind: 'iframe',
      src: `https://www.dailymotion.com/embed/video/${encodeURIComponent(value)}${query({
        autoplay: options.autoplay ? '1' : undefined,
        mute: options.autoplay || options.muted ? (options.muted === false ? undefined : '1') : undefined,
      })}`,
    };
  },
});

registerSourceScheme({
  id: 'ig',
  label: 'Instagram',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'instagram.com' && ['p', 'reel', 'reels', 'tv'].includes(path[0]) && path[1]) {
      return { scheme: 'ig', value: `${path[0] === 'p' ? 'p' : 'reel'}/${path[1]}` };
    }
    return null;
  },
  pageFor(value) {
    const [kind, code] = value.split('/');
    return `https://www.instagram.com/${kind}/${encodeURIComponent(code ?? '')}/`;
  },
  embedFor(value) {
    const [kind, code] = value.split('/');
    return { kind: 'iframe', src: `https://www.instagram.com/${kind}/${encodeURIComponent(code ?? '')}/embed` };
  },
});

registerSourceScheme({
  id: 'bsky',
  label: 'Bluesky',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'bsky.app' && path[0] === 'profile' && path[2] === 'post' && path[1] && path[3]) {
      return { scheme: 'bsky', value: `${path[1]}/${path[3]}` };
    }
    return null;
  },
  pageFor(value) {
    const [actor, rkey] = value.split('/');
    return `https://bsky.app/profile/${actor}/post/${rkey}`;
  },
  embedFor(value) {
    const [actor, rkey] = value.split('/');
    return { kind: 'iframe', src: `https://embed.bsky.app/embed/${actor}/app.bsky.feed.post/${rkey}` };
  },
});

registerSourceScheme({
  id: 'vimeo',
  label: 'Vimeo',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'vimeo.com' && path.length && /^\d+$/.test(path[path.length - 1])) {
      return { scheme: 'vimeo', value: path[path.length - 1] };
    }
    if (host === 'player.vimeo.com' && path[0] === 'video' && path[1]) return { scheme: 'vimeo', value: path[1] };
    return null;
  },
  pageFor: (value) => `https://vimeo.com/${encodeURIComponent(value)}`,
  embedFor(value, options) {
    return {
      kind: 'iframe',
      src: `https://player.vimeo.com/video/${encodeURIComponent(value)}${query({
        autoplay: options.autoplay ? '1' : undefined,
        muted: options.autoplay || options.muted ? (options.muted === false ? undefined : '1') : undefined,
        loop: options.loop ? '1' : undefined,
      })}`,
    };
  },
});

registerSourceScheme({
  id: 'sc',
  label: 'SoundCloud',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'soundcloud.com' && path.length >= 2) return { scheme: 'sc', value: path.join('/') };
    return null;
  },
  pageFor: (value) => `https://soundcloud.com/${value}`,
  embedFor(value) {
    const page = `https://soundcloud.com/${value}`;
    return { kind: 'iframe', src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(page)}` };
  },
});

registerSourceScheme({
  id: 'spotify',
  label: 'Spotify',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'open.spotify.com' && path.length >= 2) {
      const offset = path[0].startsWith('intl-') ? 1 : 0;
      return { scheme: 'spotify', value: `${path[offset]}:${path[offset + 1]}` };
    }
    return null;
  },
  pageFor(value) {
    const [type, id] = value.split(':');
    return `https://open.spotify.com/${type}/${id}`;
  },
  embedFor(value) {
    const [type, id] = value.split(':');
    return { kind: 'iframe', src: `https://open.spotify.com/embed/${type}/${id}` };
  },
});

registerSourceScheme({
  id: 'tiktok',
  label: 'TikTok',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'tiktok.com') {
      const index = path.indexOf('video');
      if (index >= 0 && path[index + 1]) return { scheme: 'tiktok', value: path[index + 1] };
    }
    return null;
  },
  pageFor: (value) => `https://www.tiktok.com/video/${encodeURIComponent(value)}`,
  embedFor(value, options) {
    return {
      kind: 'iframe',
      src: options.autoplay
        ? `https://www.tiktok.com/player/v1/${encodeURIComponent(value)}${query({
            autoplay: '1',
            muted: options.autoplay || options.muted ? (options.muted === false ? undefined : '1') : undefined,
            loop: options.loop ? '1' : undefined,
          })}`
        : `https://www.tiktok.com/embed/v2/${encodeURIComponent(value)}`,
    };
  },
});

registerSourceScheme({
  id: 'x',
  label: 'Twitter (X)',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if ((host === 'x.com' || host === 'twitter.com') && path[1] === 'status' && path[2]) {
      return { scheme: 'x', value: path[2] };
    }
    return null;
  },
  pageFor: (value) => `https://x.com/i/status/${encodeURIComponent(value)}`,
  embedFor: (value) => ({ kind: 'iframe', src: `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(value)}` }),
});

registerSourceScheme({
  id: 'twitch',
  label: 'Twitch',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'twitch.tv' && path.length) {
      if (path[0] === 'videos' && path[1]) return { scheme: 'twitch', value: `v${path[1]}` };
      return { scheme: 'twitch', value: path[0] };
    }
    return null;
  },
  pageFor(value) {
    const video = value.startsWith('v') && /^v\d+$/.test(value);
    return video ? `https://www.twitch.tv/videos/${value.slice(1)}` : `https://www.twitch.tv/${value}`;
  },
  embedFor(value, options) {
    const parent = options.parentHost ?? 'localhost';
    const video = value.startsWith('v') && /^v\d+$/.test(value);
    return {
      kind: 'iframe',
      src: video
        ? `https://player.twitch.tv/?video=${value}&parent=${parent}`
        : `https://player.twitch.tv/?channel=${encodeURIComponent(value)}&parent=${parent}`,
    };
  },
});

registerSourceScheme({
  id: 'ia',
  label: 'Internet Archive',
  media: 'iframe',
  parse(url) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (host === 'archive.org' && (path[0] === 'details' || path[0] === 'embed') && path[1]) {
      return { scheme: 'ia', value: path[1] };
    }
    return null;
  },
  pageFor: (value) => `https://archive.org/details/${encodeURIComponent(value)}`,
  embedFor: (value, options) => ({
    kind: 'iframe',
    src: `https://archive.org/embed/${encodeURIComponent(value)}${query({ autoplay: options.autoplay ? '1' : undefined })}`,
  }),
  // An Internet Archive image is its own picture, served as a still.
  imageFor: (value) => `https://archive.org/services/img/${encodeURIComponent(value)}`,
});

registerSourceScheme({
  id: 'peertube',
  label: 'PeerTube',
  media: 'iframe',
  parse(url) {
    const path = pathOf(url);
    if (path[0] === 'videos' && (path[1] === 'watch' || path[1] === 'embed') && path[2]) {
      return { scheme: 'peertube', value: `${url.host}/${path[2]}` };
    }
    if (path[0] === 'w' && path[1] && /^([1-9A-HJ-NP-Za-km-z]{20,24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(path[1])) {
      return { scheme: 'peertube', value: `${url.host}/${path[1]}` };
    }
    return null;
  },
  pageFor(value) {
    const [host, ...rest] = value.split('/');
    return `https://${host}/w/${rest.join('/')}`;
  },
  embedFor(value, options) {
    const [host, ...rest] = value.split('/');
    const id = rest.join('/');
    return {
      kind: 'iframe',
      src: `https://${host}/videos/embed/${id}${query({
        autoplay: options.autoplay ? '1' : undefined,
        muted: options.autoplay || options.muted ? (options.muted === false ? undefined : '1') : undefined,
        loop: options.loop ? '1' : undefined,
      })}`,
    };
  },
});

registerSourceScheme({
  id: 'masto',
  label: 'Mastodon',
  media: 'iframe',
  parse(url) {
    const path = pathOf(url);
    // Mastodon (and compatible) posts: https://host/@user/123456789012345678
    if (path.length === 2 && /^@[\w.]+$/.test(path[0]) && /^\d{6,20}$/.test(path[1])) {
      return { scheme: 'masto', value: `${url.host}/${path[0]}/${path[1]}` };
    }
    return null;
  },
  pageFor: (value) => `https://${value}`,
  embedFor: (value) => ({ kind: 'iframe', src: `https://${value}/embed` }),
});

registerSourceScheme({
  id: 'ipfs',
  label: 'IPFS',
  media: 'iframe',
  parse(url) {
    const path = pathOf(url);
    if (path[0] === 'ipfs' && path[1]) return { scheme: 'ipfs', value: path.slice(1).join('/') };
    const subdomain = url.hostname.match(/^([a-z0-9]{46,})\.ipfs\./);
    if (subdomain) return { scheme: 'ipfs', value: subdomain[1] + url.pathname.replace(/\/$/, '') };
    return null;
  },
  pageFor(value, options) {
    return `${(options.ipfsGateway ?? 'https://ipfs.io').replace(/\/$/, '')}/ipfs/${value}`;
  },
  embedFor(value, options) {
    return { kind: kindFromPath(value) ?? 'iframe', src: `${(options.ipfsGateway ?? 'https://ipfs.io').replace(/\/$/, '')}/ipfs/${value}` };
  },
});

registerSourceScheme({
  id: 'lemmy',
  label: 'Lemmy',
  media: 'link',
  // Lemmy posts and comments live at https://host/post/123 and /comment/123 — and the
  // shape must be exactly that: any host can be a Lemmy instance, but a looser pattern
  // would swallow other platforms' /post/<id>/<slug> links (Tumblr's, notably).
  parse(url) {
    const path = pathOf(url);
    if (path.length === 2 && (path[0] === 'post' || path[0] === 'comment') && /^\d+$/.test(path[1])) {
      return { scheme: 'lemmy', value: `${url.host}/${path[0]}/${path[1]}` };
    }
    return null;
  },
  // Lemmy has no embeddable player: the post opens on its own instance.
  pageFor: (value) => `https://${value}`,
  embedFor: () => ({ kind: 'link' as EmbedKind, src: '' }),
});

registerSourceScheme({
  id: 'url',
  label: 'Web link',
  media: 'link',
  fallback: true,
  parse: (url) => ({ scheme: 'url', value: encodeURIComponent(url.toString()) }),
  pageFor(value) {
    let page = value;
    try {
      page = decodeURIComponent(value);
    } catch {
      // keep the raw value
    }
    // A web link that is not a page after all shows with no page to open.
    return /^https?:\/\//.test(page) ? page : '';
  },
  embedFor(value) {
    let page = value;
    try {
      page = decodeURIComponent(value);
    } catch {
      // keep the raw value
    }
    if (!/^https?:\/\//.test(page)) return { kind: 'link' as EmbedKind, src: '' };
    return { kind: kindFromPath(new URL(page).pathname) ?? 'link', src: page };
  },
});

/** The labels of the built-in schemes, kept for callers that only need names. */
export const SOURCE_LABELS: Record<string, string> = Object.fromEntries(SOURCE_SCHEMES.map((scheme) => [scheme.id, scheme.label]));

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
  // Every scheme recognizes its own URLs, catch-all last; a fork's scheme slots in
  // before the generic web link.
  const fallbacks: SourceSchemeDef[] = [];
  for (const scheme of SOURCE_SCHEMES) {
    if (scheme.fallback) {
      fallbacks.push(scheme);
      continue;
    }
    const source = scheme.parse(url);
    if (source) return source;
  }
  for (const scheme of fallbacks) {
    const source = scheme.parse(url);
    if (source) return source;
  }
  return null;
}

/** How the client shows an external source. */
export function embedFor(source: ExternalSource, options: EmbedOptions = {}): Embed {
  const scheme = sourceSchemeOf(source.scheme);
  const label = scheme?.label ?? String(source.scheme);
  if (!scheme) return { kind: 'link', src: '', page: '', label };
  const embed = scheme.embedFor(source.value, options);
  return { kind: embed.kind, src: embed.src, page: scheme.pageFor(source.value, options), label };
}

/** Hosts of `url:` sources that deserve a proper platform name. */
const HOST_NAMES: Record<string, string> = {
  'flickr.com': 'Flickr',
  'staticflickr.com': 'Flickr',
  'commons.wikimedia.org': 'Wikimedia Commons',
  'upload.wikimedia.org': 'Wikimedia Commons',
  'wordpress.org': 'Openverse',
  'openverse.org': 'Openverse',
  'reddit.com': 'Reddit',
  'imgur.com': 'Imgur',
  'pixelfed.social': 'Pixelfed',
  'unsplash.com': 'Unsplash',
  'pexels.com': 'Pexels',
  'bandcamp.com': 'Bandcamp',
  'twitch.tv': 'Twitch',
  'x.com': 'Twitter (X)',
  'twitter.com': 'Twitter (X)',
};

export interface Platform {
  /** Stable key, e.g. vibeshare, yt, flickr.com. */
  key: string;
  name: string;
  /** Where the content lives on that platform. */
  page?: string;
}

/**
 * The platform a content id comes from: VibeShare for native content, otherwise the
 * site of its source (YouTube, PeerTube, the host of a link…).
 */
export function platformOf(id: string): Platform {
  const parsed = parseContentId(id);
  if (!parsed || parsed.native) return { key: 'vibeshare', name: 'VibeShare' };
  const source = parsed.sources[0];
  const embed = embedFor(source);
  const label = sourceSchemeLabel(source.scheme) ?? String(source.scheme);
  if (source.scheme === 'url' || source.scheme === 'ipfs') {
    let host = '';
    try {
      host = new URL(embed.page).hostname.replace(/^(www|m)\./, '');
    } catch {
      return { key: source.scheme, name: label };
    }
    const known = Object.keys(HOST_NAMES).find((name) => host === name || host.endsWith(`.${name}`));
    return { key: known ?? host, name: known ? HOST_NAMES[known] : host || label, page: embed.page || undefined };
  }
  return { key: source.scheme, name: label, page: embed.page || undefined };
}

/**
 * The VibeShare creator a link points at: a creator id (`vk1…`, `name:my-studio`, or a
 * link id like `yt:abcdef`), or a VibeShare page URL carrying `/creator/<id>` (the id is
 * parsed out of it). Anything pointing outside VibeShare is refused — the related-creators
 * carousel only links inside VibeShare.
 */
export function creatorRefOf(text: string): string | null {
  const input = String(text ?? '').trim();
  if (!input || /\s/.test(input)) return null;
  const isUrl =
    /^https?:\/\//i.test(input) || /^www\./i.test(input) || input.startsWith('/') || input.startsWith('#/') || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(input);
  if (isUrl) {
    const at = input.indexOf('/creator/');
    if (at < 0) return null;
    const rest = input.slice(at + '/creator/'.length);
    let id = rest.split(/[?#]/)[0]?.replace(/\/+$/, '') ?? '';
    try {
      id = decodeURIComponent(id);
    } catch {
      // a malformed escape: the raw text stands
    }
    return id && !/\s/.test(id) ? id.slice(0, 128) : null;
  }
  return input.slice(0, 128);
}
