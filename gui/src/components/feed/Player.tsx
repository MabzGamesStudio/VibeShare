import { ExternalLink, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FeedItem } from '../../../../src/shared/clientapi';
import { platformOf } from '../../../../src/shared/sources';
import { controlEmbed, embedsBlocked, nodePreviewOf, placeholderFor, playableFor, useMediaSrc, type Playable } from '../../media';
import { gradientFor } from '../../util';
import { FormatIcon } from '../ContentCard';

/** A still preview: the thumbnail, or a lovely gradient placeholder with the format's icon. */
export function Poster({ item, src, fit = 'cover' }: { item: FeedItem; src?: string; fit?: 'cover' | 'contain' }) {
  const [failed, setFailed] = useState(false);
  const blocked = placeholderFor(item);
  // Cookies off: nothing loads from the platform, but the preview the algorithm node
  // keeps of the content is ours and still stands in for the video's preview.
  const image = useMediaSrc(blocked ? nodePreviewOf(item) : (src ?? item.thumbnailUrl));
  if (!image || failed) {
    return (
      <div className="poster poster-empty" style={{ background: gradientFor(item.id) }}>
        <FormatIcon format={item.format} size={46} />
        {blocked && (
          <div className="poster-placeholder">
            <span className="poster-placeholder-title">{item.title}</span>
            {item.creator && <span className="poster-placeholder-creator">{item.creator.name}</span>}
            <span className="poster-placeholder-note">External preview hidden</span>
          </div>
        )}
      </div>
    );
  }
  return <img className={`poster poster-${fit}`} src={image} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export interface MediaViewProps {
  item: FeedItem;
  /** Load the player and start playing (iframes are only loaded while active). */
  active: boolean;
  /** Paused by the user while active. */
  paused?: boolean;
  muted: boolean;
  loop?: boolean;
  controls?: boolean;
  fit?: 'cover' | 'contain';
  ipfsGateway?: string;
  /** Shown instead of the player while inactive (defaults to the thumbnail). */
  posterSrc?: string;
  onActivate?: () => void;
}

/**
 * Plays an item inline: native content through the client, platform media files
 * directly, everything else in the platform's embedded player. Falls back to the next
 * option when one fails.
 */
export function MediaView({ item, active, paused = false, muted, loop = true, controls = false, fit = 'contain', ipfsGateway, posterSrc, onActivate }: MediaViewProps) {
  // Embedded players get the mute state they start with in their URL; later changes go
  // by message, or reload the player when it does not take messages.
  const [urlMuted, setUrlMuted] = useState(muted);
  const primary = useMemo(() => playableFor(item, { autoplay: true, muted: urlMuted, loop, ipfsGateway }), [item, urlMuted, loop, ipfsGateway]);
  const [failed, setFailed] = useState(0);
  let playable: Playable | undefined = primary;
  for (let i = 0; i < failed && playable; i++) playable = playable.fallback;
  const media = useRef<HTMLVideoElement | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const mediaSrc = useMediaSrc(playable && playable.kind !== 'iframe' && playable.kind !== 'none' ? playable.src : undefined);

  useEffect(() => setFailed(0), [item.id]);

  useEffect(() => {
    const element = media.current;
    if (!element) return;
    element.muted = muted;
    if (active && !paused) element.play().catch(() => undefined);
    else element.pause();
  }, [active, paused, muted, mediaSrc]);

  useEffect(() => {
    if (playable?.kind !== 'iframe' || !active) return;
    if (muted !== urlMuted && !controlEmbed(frame.current, playable.src, muted ? 'mute' : 'unmute')) setUrlMuted(muted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted]);

  useEffect(() => {
    if (playable?.kind === 'iframe' && active) controlEmbed(frame.current, playable.src, paused ? 'pause' : 'play');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  if (!playable || playable.kind === 'none') {
    const page = playable?.page ?? item.pageUrl ?? platformOf(item.id).page;
    return (
      <div className="media-view">
        <Poster item={item} src={posterSrc} fit="cover" />
        {embedsBlocked() && (
          <p className="small faint embed-placeholder-text" style={{ position: 'absolute', bottom: 8, left: 10, right: 10, textAlign: 'center' }}>
            Third-party embeds are off (they carry third-party tracking cookies) — allow them in{' '}
            <Link className="link" to="/settings#privacy">
              Settings → Privacy
            </Link>
          </p>
        )}
        {page && (
          <a className="media-open button" href={page} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            <ExternalLink size={15} /> Open on {platformOf(item.id).name}
          </a>
        )}
      </div>
    );
  }

  if (playable.kind === 'image') {
    return (
      <div className="media-view">
        {mediaSrc && <img className={`media-${fit}`} src={mediaSrc} alt={item.title} onError={() => setFailed((n) => n + 1)} />}
      </div>
    );
  }

  if (playable.kind === 'iframe') {
    return (
      <div className="media-view">
        {active ? (
          <iframe
            ref={frame}
            key={playable.src}
            src={playable.src}
            title={item.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button type="button" className="media-poster" onClick={onActivate} aria-label={`Play ${item.title}`}>
            <Poster item={item} src={posterSrc} fit="cover" />
            {onActivate && (
              <span className="play-badge">
                <Play size={26} fill="currentColor" />
              </span>
            )}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="media-view">
      {playable.kind === 'audio' && <Poster item={item} src={posterSrc} fit="cover" />}
      <video
        ref={media}
        key={playable.src}
        className={`media-${fit} ${playable.kind === 'audio' ? 'media-audio' : ''}`}
        src={mediaSrc}
        poster={playable.kind === 'video' ? (posterSrc ?? item.thumbnailUrl) : undefined}
        muted={muted}
        loop={loop}
        playsInline
        controls={controls || playable.kind === 'audio'}
        preload={active ? 'auto' : 'metadata'}
        onError={() => setFailed((n) => n + 1)}
      />
    </div>
  );
}
