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

export function embedPlayable(item: Pick<FeedItem, 'id'>, options: PlayOptions = {}): Playable {
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
  if (item.media && /^https?:\/\//.test(item.media.url)) {
    return { kind: item.media.type, src: item.media.url, page: item.pageUrl ?? embed.page, fallback: embed.kind !== 'none' ? embed : undefined };
  }
  return { ...embed, page: item.pageUrl ?? embed.page };
}

/** The best still image of an item: the image itself for images, otherwise its thumbnail. */
export function imageFor(item: Pick<FeedItem, 'id' | 'format' | 'media' | 'thumbnailUrl'>): string | undefined {
  const parsed = parseContentId(item.id);
  if (item.format === 'image') {
    if (parsed?.native) return streamUrl(parsed.base);
    if (item.media?.type === 'image') return item.media.url;
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
