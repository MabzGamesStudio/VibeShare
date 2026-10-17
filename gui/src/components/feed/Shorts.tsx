import { ChevronDown, ChevronUp, Info, Pause, ThumbsUp, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { FeedItem, PageConfig } from '../../../../src/shared/clientapi';
import { api, errorMessage } from '../../api';
import { markPreviewed, useTrackingPreviews } from '../../bloom';
import { useApp } from '../../state';
import { watchPath } from '../../util';
import { ShareButton } from '../Share';
import { Spinner } from '../ui';
import { compact, Fields } from './Fields';
import { MediaView, Poster } from './Player';
import type { Paged } from './usePaged';

/** Likes without asking the node for each short's vote first (no request per swipe). */
function LikeButton({ item }: { item: FeedItem }) {
  const { toast, refresh } = useApp();
  const [vote, setVote] = useState(0);
  const [likes, setLikes] = useState(item.stats.likes);
  const count = likes || item.stats.platformLikes;
  return (
    <button
      type="button"
      className={`rail-button ${vote === 1 ? 'on' : ''}`}
      aria-pressed={vote === 1}
      aria-label="Like"
      onClick={async () => {
        const next = vote === 1 ? 0 : 1;
        try {
          const result = await api<{ likes: number; credited: number }>('/api/vote', { body: { nodeId: item.via, id: item.id, vote: next } });
          setVote(next);
          setLikes(result.likes);
          if (result.credited) {
            toast(`+${result.credited} credits on ${item.viaName} for voting`, 'success');
            void refresh();
          }
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      }}
    >
      <ThumbsUp size={22} fill={vote === 1 ? 'currentColor' : 'none'} />
      <span>{count ? compact(count) : 'Like'}</span>
    </button>
  );
}

function Short({
  item,
  page,
  active,
  near,
  muted,
  paused,
  ipfsGateway,
  onToggleMute,
  onTogglePause,
}: {
  item: FeedItem;
  page: PageConfig;
  active: boolean;
  near: boolean;
  muted: boolean;
  paused: boolean;
  ipfsGateway: string;
  onToggleMute: () => void;
  onTogglePause: () => void;
}) {
  return (
    <div className="short-stage">
      <div className="short-frame">
        {near ? (
          <MediaView item={item} active={active && page.options.autoplay} paused={paused} muted={muted} fit="contain" ipfsGateway={ipfsGateway} />
        ) : (
          <Poster item={item} />
        )}
        {/* Catches swipes and taps over embedded players, which would otherwise swallow them. */}
        <div className="short-shield" onClick={onTogglePause} />
        {active && paused && (
          <div className="short-paused">
            <Pause size={34} />
          </div>
        )}
        {page.fields.length > 0 && (
          <div className="short-info">
            <Fields item={item} fields={page.fields} variant="overlay" />
          </div>
        )}
      </div>
      <div className="short-rail">
        <LikeButton item={item} />
        <ShareButton target={{ id: item.id, title: item.title }} className="rail-button" label="Share" />
        <button type="button" className="rail-button" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
          {muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
          <span>{muted ? 'Sound' : 'Mute'}</span>
        </button>
        <Link to={watchPath(item.id)} className="rail-button" aria-label="Details">
          <Info size={22} />
          <span>Details</span>
        </Link>
      </div>
    </div>
  );
}

/**
 * One short at a time, filling the screen. Swipe (or scroll, or use the arrow keys) up
 * and down; the short in view plays, the others stop. More load as you go.
 */
export function ShortsLayout({ paged, page, ipfsGateway, header, empty }: { paged: Paged; page: PageConfig; ipfsGateway: string; header: ReactNode; empty: ReactNode }) {
  const { items, loading, done, loadMore } = paged;
  const container = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | undefined>();
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(page.options.muted);
  const [paused, setPaused] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Fill the window below the top bar.
  useLayoutEffect(() => {
    const fit = () => {
      const element = container.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(360, window.innerHeight - top));
    };
    window.scrollTo(0, 0);
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Back to the top when the list starts over (another page, other filters).
  useEffect(() => {
    if (items.length === 0) {
      setActive(0);
      container.current?.scrollTo({ top: 0 });
    }
  }, [items.length]);

  useEffect(() => {
    if (items.length && active >= items.length - 3 && !done) loadMore();
  }, [active, items.length, done, loadMore]);

  // Remember what was watched (after a moment, not while swiping past).
  const current = items[active];
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(
      () => void api('/api/history', { body: { id: current.id, title: current.title, contentId: current.contentId, link: current.link } }).catch(() => undefined),
      2500
    );
    return () => clearTimeout(timer);
  }, [current]);

  // The preview is on screen the moment the short shows: the seen-content filters record it.
  const tracking = useTrackingPreviews();
  useEffect(() => {
    if (current) markPreviewed(current, tracking);
  }, [current?.id, tracking]);

  const onScroll = () => {
    const element = container.current;
    if (!element || !element.clientHeight) return;
    const index = Math.round(element.scrollTop / element.clientHeight);
    if (index !== activeRef.current) {
      setActive(index);
      setPaused(false);
    }
  };

  const go = useCallback(
    (delta: number) => {
      const element = container.current;
      if (!element) return;
      const last = Math.max(0, items.length - 1 + (done ? 1 : 0));
      const next = Math.min(last, Math.max(0, activeRef.current + delta));
      element.scrollTo({ top: next * element.clientHeight, behavior: 'smooth' });
    },
    [items.length, done]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (target?.closest('input, textarea, select, [contenteditable="true"], .modal-backdrop')) return;
      if (['ArrowDown', 'PageDown', 'j'].includes(event.key)) go(1);
      else if (['ArrowUp', 'PageUp', 'k'].includes(event.key)) go(-1);
      else if (event.key === 'm') setMuted((value) => !value);
      else if (event.key === ' ' && !target?.closest('button, a')) setPaused((value) => !value);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  return (
    <div className="shorts-wrap" style={{ height }}>
      <div className="shorts-header">{header}</div>
      <div className="shorts" ref={container} onScroll={onScroll} tabIndex={-1}>
        {items.map((item, index) => {
          const distance = Math.abs(index - active);
          return (
            <section key={item.id} className="short" aria-label={item.title} aria-current={index === active}>
              {distance <= 3 && (
                <Short
                  item={item}
                  page={page}
                  active={index === active}
                  near={distance <= 1}
                  muted={muted}
                  paused={paused}
                  ipfsGateway={ipfsGateway}
                  onToggleMute={() => setMuted((value) => !value)}
                  onTogglePause={() => setPaused((value) => !value)}
                />
              )}
            </section>
          );
        })}
        {items.length === 0 && !loading && <section className="short short-message">{empty}</section>}
        {loading && (
          <section className="short short-message">
            <Spinner />
          </section>
        )}
        {done && items.length > 0 && (
          <section className="short short-message">
            <div>
              <h2>You are all caught up</h2>
              <p className="muted">Your algorithm nodes have no more shorts for this page right now.</p>
              <button style={{ marginTop: 16 }} onClick={() => paged.reload()}>
                Start over
              </button>
            </div>
          </section>
        )}
      </div>
      <div className="shorts-nav">
        <button className="round icon" onClick={() => go(-1)} disabled={active === 0} aria-label="Previous">
          <ChevronUp size={22} />
        </button>
        <button className="round icon" onClick={() => go(1)} disabled={active >= items.length - 1 && (done || !items.length)} aria-label="Next">
          <ChevronDown size={22} />
        </button>
      </div>
    </div>
  );
}
