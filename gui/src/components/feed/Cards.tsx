import { useEffect, useMemo, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FeedItem, PageConfig } from '../../../../src/shared/clientapi';
import { aspectOf, imageFor } from '../../media';
import { formatDuration, watchPath } from '../../util';
import { ShareButton } from '../Share';
import { Fields } from './Fields';
import { MediaView, Poster } from './Player';

/** A preview image that never costs credits: thumbnails, or a platform's own image. */
function previewOf(item: FeedItem): string | undefined {
  if (item.thumbnailUrl) return item.thumbnailUrl;
  if (item.media?.type === 'image') return item.media.url;
  return undefined;
}

const VIDEO_FORMATS = new Set(['video', 'short-video', 'live']);

/**
 * The picture of an item. In inline mode (the dual view) clicking a video starts playing
 * it in place instead of opening its content page.
 */
export function ItemThumb({ item, share = true, inline = false }: { item: FeedItem; share?: boolean; inline?: boolean }) {
  const video = inline && VIDEO_FORMATS.has(item.format);
  const [playing, setPlaying] = useState(false);
  if (video) {
    return (
      <div className="thumb">
        <button type="button" className="thumb-link" aria-label={playing ? `Pause ${item.title}` : `Play ${item.title}`} onClick={() => setPlaying((on) => !on)}>
          {playing ? (
            <MediaView item={item} active paused={false} muted controls loop={false} />
          ) : (
            <>
              <Poster item={item} src={previewOf(item)} />
              <span className="thumb-overlay">
                <span className="play-badge">
                  <Play size={22} fill="currentColor" />
                </span>
                {item.durationSeconds ? <span className="thumb-label">{formatDuration(item.durationSeconds)}</span> : null}
              </span>
            </>
          )}
        </button>
        {share && (
          <span className="thumb-actions">
            <ShareButton target={{ id: item.id, title: item.title }} className="overlay-button" />
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="thumb">
      {/* Just the picture and its length: format and age rating are metadata fields a page can show. */}
      <Link to={watchPath(item.id)} className="thumb-link" aria-label={item.title}>
        <Poster item={item} src={previewOf(item)} />
        {item.durationSeconds ? (
          <span className="thumb-overlay">
            <span className="thumb-label">{formatDuration(item.durationSeconds)}</span>
          </span>
        ) : null}
      </Link>
      {share && (
        <span className="thumb-actions">
          <ShareButton target={{ id: item.id, title: item.title }} className="overlay-button" />
        </span>
      )}
    </div>
  );
}

// Big previews: fewer items per screen, and fewer fetched at once.
const MIN_WIDTH = { small: 240, medium: 340, large: 440 };

export function GridLayout({ items, page, inline = false }: { items: FeedItem[]; page: PageConfig; inline?: boolean }) {
  const { columns, size } = page.options;
  const style = { gridTemplateColumns: columns ? `repeat(${columns}, minmax(0, 1fr))` : `repeat(auto-fill, minmax(${MIN_WIDTH[size]}px, 1fr))` };
  return (
    <div className="grid" style={style}>
      {items.map((item) => (
        <div key={item.id} className={`content-card ${page.thumbnail ? '' : 'text-only'}`}>
          {page.thumbnail && <ItemThumb item={item} inline={inline} />}
          <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 4 }}>
            <Fields item={item} fields={page.fields} variant="card" />
            {!page.thumbnail && <ShareButton target={{ id: item.id, title: item.title }} />}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListLayout({ items, page, inline = false }: { items: FeedItem[]; page: PageConfig; inline?: boolean }) {
  return (
    <div className={`list list-${page.options.size}`}>
      {items.map((item) => (
        <div key={item.id} className="list-row">
          {page.thumbnail && <ItemThumb item={item} share={false} inline={inline} />}
          <Fields item={item} fields={page.fields} variant="compact" />
          <ShareButton target={{ id: item.id, title: item.title }} />
        </div>
      ))}
    </div>
  );
}

const MASONRY_WIDTH = { small: 220, medium: 300, large: 440 };
const GAP = 14;

/** The media of a masonry tile: in inline mode (dual view) a video plays in place. */
function TileMedia({ item, inline, src }: { item: FeedItem; inline: boolean; src?: string }) {
  const video = inline && VIDEO_FORMATS.has(item.format);
  const [playing, setPlaying] = useState(false);
  if (video) {
    return (
      <button type="button" className="thumb-link" onClick={() => setPlaying((on) => !on)} aria-label={playing ? `Pause ${item.title}` : `Play ${item.title}`}>
        {playing ? <MediaView item={item} active paused={false} muted controls loop={false} /> : <Poster item={item} src={src} />}
      </button>
    );
  }
  return (
    <Link to={watchPath(item.id)} aria-label={item.title}>
      <Poster item={item} src={src} />
    </Link>
  );
}

/** Columns of different heights; new items go to the shortest column, so nothing moves. */
export function MasonryLayout({ items, page, inline = false }: { items: FeedItem[]; page: PageConfig; inline?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const count = page.options.columns || Math.max(1, Math.floor((width + GAP) / (MASONRY_WIDTH[page.options.size] + GAP)));
  const columns = useMemo(() => {
    const lists: FeedItem[][] = Array.from({ length: count }, () => []);
    const heights = new Array<number>(count).fill(0);
    for (const item of items) {
      const shortest = heights.indexOf(Math.min(...heights));
      lists[shortest].push(item);
      const aspect = aspectOf(item) ?? (item.format === 'image' ? 1 : 16 / 9);
      heights[shortest] += 1 / aspect + 0.3;
    }
    return lists;
  }, [items, count]);
  return (
    <div className="masonry" ref={ref}>
      {width > 0 &&
        columns.map((column, i) => (
          <div key={i} className="masonry-column">
            {column.map((item) => {
              const aspect = aspectOf(item);
              const src = imageFor(item) ?? previewOf(item);
              return (
                <div key={item.id} className="masonry-tile">
                  <div className="masonry-media" style={aspect ? { aspectRatio: String(aspect) } : undefined}>
                    <TileMedia item={item} inline={inline} src={src} />
                    <span className="thumb-actions">
                      <ShareButton target={{ id: item.id, title: item.title }} className="overlay-button" />
                    </span>
                  </div>
                  {page.fields.length > 0 && <Fields item={item} fields={page.fields} variant="compact" />}
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}
