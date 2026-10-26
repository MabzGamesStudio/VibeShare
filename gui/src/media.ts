// What to show or play for a content item: native content streams through the client
// backend; discovered content plays from the platform's own media file, or its embed.
import { useEffect, useState } from 'react';
import type { FeedItem } from '../../src/shared/clientapi';
import { embedFor, parseContentId } from '../../src/shared/sources';
import { needsResolving, resolveStream, streamUrl } from './api';

export interface Playable {
  kind: 'video' | 'audio' | 'image' | 'iframe' | 'none';
  src: string;
  /** What to try when this fails (native content no provider has, a dead media link). */
  fallback?: Playable;
  /** Page of the content on its platform. */
  page?: string;
}

export interface PlayOptions {
  autoplay?: boolean;
  muted?: boolean;
  loop?: boolean;
  ipfsGateway?: string;
}

const AUDIO_FORMATS = new Set(['music', 'audio', 'podcast']);

/**
 * When on, no external content is embedded or previewed: only content hosted on the
 * network (its cid) plays and only its metadata shows, with a lovely placeholder in
 * place of the platform's picture or player.
 */
let blockExternal = false;
let contentPreviews = true;

export function setBlockExternalEmbeds(blocked: boolean): void {
  blockExternal = blocked;
}

/** Applies immediately, including to feed pages loaded before the setting changed. */
export function setContentPreviews(show: boolean): void {
  contentPreviews = show;
}

export function previewsEnabled(): boolean {
  return contentPreviews;
}

/** True when external content is turned off (settings or the cookie choice). */
export function embedsBlocked(): boolean {
  return blockExternal;
}

/** True when this item is external (no cid) and external content is disabled. */
export function placeholderFor(item: Pick<FeedItem, 'id'>): boolean {
  return blockExternal && !parseContentId(item.id)?.native;
}

export function embedPlayable(item: Pick<FeedItem, 'id'>, options: PlayOptions = {}): Playable {
  if (blockExternal) return { kind: 'none', src: '' };
  const source = parseContentId(item.id)?.sources[0];
  if (!source) return { kind: 'none', src: '' };
  const embed = embedFor(source, { ...options, parentHost: location.hostname });
  if (embed.kind === 'link') return { kind: 'none', src: '', page: embed.page };
  return { kind: embed.kind, src: embed.src, page: embed.page };
}

export function playableFor(item: Pick<FeedItem, 'id' | 'format' | 'media' | 'pageUrl'>, options: PlayOptions = {}): Playable {
  const parsed = parseContentId(item.id);
  const embed = embedPlayable(item, options);
  if (parsed?.native) {
    const kind = item.format === 'image' ? 'image' : AUDIO_FORMATS.has(item.format) ? 'audio' : 'video';
    return { kind, src: streamUrl(parsed.base), fallback: embed.kind !== 'none' ? embed : undefined };
  }
  if (blockExternal) return { kind: 'none', src: '', page: item.pageUrl };
  if (item.media && /^https?:\/\//.test(item.media.url)) {
    return { kind: item.media.type, src: item.media.url, page: item.pageUrl ?? embed.page, fallback: embed.kind !== 'none' ? embed : undefined };
  }
  // An Internet Archive image with no media URL still shows as the image itself — the
  // feed renders it right away instead of an embedded player with a play button.
  const source = parsed?.sources[0];
  if (item.format === 'image' && source?.scheme === 'ia') {
    return { kind: 'image', src: `https://archive.org/services/img/${encodeURIComponent(source.value)}`, page: item.pageUrl ?? embed.page };
  }
  return { ...embed, page: item.pageUrl ?? embed.page };
}

/**
 * The preview image the algorithm node keeps of the content on its own disk, served
 * through our own node. It is first-party, so it still shows when cookies are off and
 * nothing may be fetched from the platform the content was discovered on.
 */
export function nodePreviewOf(item: Pick<FeedItem, 'format' | 'thumbnail' | 'thumbnailUrl'>): string | undefined {
  if (!contentPreviews) return undefined;
  // An image is its own content (the full picture loads from its platform): only a
  // video's preview stands in from the node's copy.
  if (item.format === 'image') return undefined;
  return item.thumbnail?.startsWith('/v1/thumbnails/') ? item.thumbnailUrl : undefined;
}

/** The best still image of an item: the image itself for images, otherwise its thumbnail. */
export function imageFor(item: Pick<FeedItem, 'id' | 'format' | 'media' | 'thumbnail' | 'thumbnailUrl'>): string | undefined {
  if (!contentPreviews) return undefined;
  const parsed = parseContentId(item.id);
  // With cookies off, the platform's picture may not load — but the preview the
  // algorithm node keeps of the content is ours, and stands in for a video's preview.
  if (placeholderFor(item)) return nodePreviewOf(item);
  if (item.format === 'image') {
    if (parsed?.native) return streamUrl(parsed.base);
    if (item.media?.type === 'image') return item.media.url;
    // An Internet Archive image is its own picture: it loads in the feed at once.
    const ia = parsed?.sources[0];
    if (ia?.scheme === 'ia') return `https://archive.org/services/img/${encodeURIComponent(ia.value)}`;
  }
  return item.thumbnailUrl;
}

/** Width / height of an item when known (for vertical layouts). */
export function aspectOf(item: Pick<FeedItem, 'media' | 'format'>): number | undefined {
  if (item.media?.width && item.media.height) return item.media.width / item.media.height;
  if (item.format === 'short-video') return 9 / 16;
  return undefined;
}

export type EmbedCommand = 'play' | 'pause' | 'mute' | 'unmute';

/**
 * Sends a command to an embedded player that accepts commands by message (YouTube with
 * its JS API enabled, Vimeo). Returns false for players that cannot be controlled.
 */
export function controlEmbed(frame: HTMLIFrameElement | null, src: string, command: EmbedCommand): boolean {
  const target = frame?.contentWindow;
  if (!target) return false;
  if (/^https:\/\/www\.youtube(-nocookie)?\.com\/embed\/.*enablejsapi=1/.test(src)) {
    const func = { play: 'playVideo', pause: 'pauseVideo', mute: 'mute', unmute: 'unMute' }[command];
    target.postMessage(JSON.stringify({ event: 'command', func, args: [] }), new URL(src).origin);
    return true;
  }
  if (src.startsWith('https://player.vimeo.com/')) {
    const message = command === 'play' || command === 'pause' ? { method: command } : { method: 'setVolume', value: command === 'mute' ? 0 : 1 };
    target.postMessage(JSON.stringify(message), 'https://player.vimeo.com');
    return true;
  }
  return false;
}

/**
 * The URL to give a media element. Stream URLs work as they are, except in the web
 * client without a service worker, where they become blob URLs (undefined until ready).
 */
export function useMediaSrc(src: string | undefined): string | undefined {
  const direct = !src || !needsResolving(src);
  const [resolved, setResolved] = useState<string | undefined>(direct ? src : undefined);
  useEffect(() => {
    if (!src || !needsResolving(src)) {
      setResolved(src);
      return;
    }
    let cancelled = false;
    setResolved(undefined);
    resolveStream(src)
      .then((url) => !cancelled && setResolved(url))
      .catch(() => !cancelled && setResolved(undefined));
    return () => {
      cancelled = true;
    };
  }, [src]);
  return direct ? src : resolved;
}
