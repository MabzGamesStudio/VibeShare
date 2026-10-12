import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FeedItem, PageConfig } from '../../../../src/shared/clientapi';
import { aspectOf, imageFor } from '../../media';
import { formatDuration, watchPath } from '../../util';
import { ShareButton } from '../Share';
import { Fields } from './Fields';
import { Poster } from './Player';

/** A preview image that never costs credits: thumbnails, or a platform's own image. */
function previewOf(item: FeedItem): string | undefined {
  if (item.thumbnailUrl) return item.thumbnailUrl;
  if (item.media?.type === 'image') return item.media.url;
  return undefined;
}

export function ItemThumb({ item, share = true }: { item: FeedItem; share?: boolean }) {
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

export function GridLayout({ items, page }: { items: FeedItem[]; page: PageConfig }) {
  const { columns, size } = page.options;
  const style = { gridTemplateColumns: columns ? `repeat(${columns}, minmax(0, 1fr))` : `repeat(auto-fill, minmax(${MIN_WIDTH[size]}px, 1fr))` };
  return (
    <div className="grid" style={style}>
      {items.map((item) => (
        <div key={item.id} className={`content-card ${page.thumbnail ? '' : 'text-only'}`}>
          {page.thumbnail && <ItemThumb item={item} />}
          <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 4 }}>
            <Fields item={item} fields={page.fields} variant="card" />
            {!page.thumbnail && <ShareButton target={{ id: item.id, title: item.title }} />}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListLayout({ items, page }: { items: FeedItem[]; page: PageConfig }) {
  return (
    <div className={`list list-${page.options.size}`}>
      {items.map((item) => (
        <div key={item.id} className="list-row">
          {page.thumbnail && <ItemThumb item={item} share={false} />}
          <Fields item={item} fields={page.fields} variant="compact" />
          <ShareButton target={{ id: item.id, title: item.title }} />
        </div>
      ))}
    </div>
  );
}

const MASONRY_WIDTH = { small: 220, medium: 300, large: 400 };
const GAP = 14;

/** Columns of different heights; new items go to the shortest column, so nothing moves. */
export function MasonryLayout({ items, page }: { items: FeedItem[]; page: PageConfig }) {
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
                    <Link to={watchPath(item.id)} aria-label={item.title}>
                      <Poster item={item} src={src} />
                    </Link>
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
