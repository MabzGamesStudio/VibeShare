import { Move } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FeedItem } from '../../../../src/shared/clientapi';
import { watchPath } from '../../util';
import { Spinner } from '../ui';
import { Poster } from './Player';
import type { Paged } from './usePaged';

// A 2D plane of cards you move around in every direction (wheel, trackpad, drag, arrow
// keys). Items are laid out in a spiral from the middle, so the first recommendations
// are closest. Near the middle a lens slows cards down and brings them forward: they
// grow, come to the front and fade in from black.

const CELL_W = 330;
const CELL_H = 290;

/** Cards keep their media's shape: shorts stand, images and music are square, videos lie. */
function cardSize(item: FeedItem | undefined): { w: number; h: number } {
  if (!item) return { w: 220, h: 160 };
  if (item.format === 'short-video') return { w: 146, h: 260 };
  if (['image', 'music', 'audio', 'podcast'].includes(item.format)) return { w: 204, h: 204 };
  return { w: 272, h: 153 };
}

/** Position of cell (x, y) in a square spiral around (0, 0): 0, then 8 in ring 1, 16 in ring 2… */
export function spiralIndex(x: number, y: number): number {
  const k = Math.max(Math.abs(x), Math.abs(y));
  if (k === 0) return 0;
  const before = (2 * k - 1) ** 2;
  if (x === k && y > -k) return before + (y + k - 1);
  if (y === k) return before + 2 * k + (k - 1 - x);
  if (x === -k) return before + 4 * k + (k - 1 - y);
  return before + 6 * k + (x + k - 1);
}

/** World position of a cell's center (odd rows shifted half a cell, like a honeycomb). */
function cellCenter(x: number, y: number): { x: number; y: number } {
  return { x: x * CELL_W + (Math.abs(y) % 2 === 1 ? CELL_W / 2 : 0), y: y * CELL_H };
}

function previewOf(item: FeedItem): string | undefined {
  if (item.thumbnailUrl) return item.thumbnailUrl;
  if (item.media?.type === 'image') return item.media.url;
  return undefined;
}

interface Cell {
  key: string;
  x: number;
  y: number;
  index: number;
}

export function CanvasLayout({ paged, header, empty }: { paged: Paged; header: ReactNode; empty: ReactNode }) {
  const { items, loading, done, loadMore, failure } = paged;
  const navigate = useNavigate();
  const wrap = useRef<HTMLDivElement | null>(null);
  const plane = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | undefined>();
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const camera = useRef({ x: 0, y: 0, vx: 0, vy: 0, dragging: false, idle: 0 });
  const [windowKey, setWindowKey] = useState('0,0');
  const [hint, setHint] = useState(true);

  // Fill the window below the top bar.
  useLayoutEffect(() => {
    const fit = () => {
      const element = wrap.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(420, window.innerHeight - top));
      setSize({ w: element.clientWidth, h: Math.max(420, window.innerHeight - top) });
    };
    window.scrollTo(0, 0);
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Which item a cell shows. Once the feed has ended it repeats (shuffled, so repeats are
  // not next to each other), and the plane never runs out.
  const itemAt = useCallback(
    (index: number): FeedItem | undefined => {
      if (index < items.length) return items[index];
      if (!done || !items.length) return undefined;
      const n = items.length;
      const cycle = Math.floor(index / n);
      return items[(index * 7919 + cycle * 104729) % n];
    },
    [items, done]
  );

  // The cells around the camera (recomputed only when the camera crosses a cell).
  const cells = useMemo<Cell[]>(() => {
    const [cx, cy] = windowKey.split(',').map(Number);
    const spanX = Math.ceil(size.w / CELL_W / 2) + 2;
    const spanY = Math.ceil(size.h / CELL_H / 2) + 2;
    const list: Cell[] = [];
    for (let y = cy - spanY; y <= cy + spanY; y++) {
      for (let x = cx - spanX; x <= cx + spanX; x++) list.push({ key: `${x},${y}`, x, y, index: spiralIndex(x, y) });
    }
    return list;
  }, [windowKey, size]);

  // Ask for more when cells without content come into reach (after the usual pause).
  useEffect(() => {
    if (done || loading || !items.length) return;
    const furthest = Math.max(...cells.map((cell) => cell.index));
    if (furthest >= items.length - 4) loadMore();
  }, [cells, items.length, done, loading, loadMore]);

  // The animation: camera physics, the lens and every card's transform, without React renders.
  useEffect(() => {
    let frame = 0;
    const step = () => {
      const cam = camera.current;
      if (!cam.dragging) {
        cam.x += cam.vx;
        cam.y += cam.vy;
        cam.vx *= 0.9;
        cam.vy *= 0.9;
        if (Math.abs(cam.vx) + Math.abs(cam.vy) < 0.3) {
          cam.vx = 0;
          cam.vy = 0;
          // At rest, settle gently on the card nearest the middle.
          cam.idle++;
          if (cam.idle > 12) {
            const gy = Math.round(cam.y / CELL_H);
            const gx = Math.round((cam.x - (Math.abs(gy) % 2 === 1 ? CELL_W / 2 : 0)) / CELL_W);
            const target = cellCenter(gx, gy);
            cam.x += (target.x - cam.x) * 0.08;
            cam.y += (target.y - cam.y) * 0.08;
          }
        } else cam.idle = 0;
      }
      const gy = Math.round(cam.y / CELL_H);
      const gx = Math.round(cam.x / CELL_W);
      const key = `${gx},${gy}`;
      setWindowKey((current) => (current === key ? current : key));

      const element = plane.current;
      if (element) {
        const w = element.clientWidth;
        const h = element.clientHeight;
        const lens = Math.min(w, h) * 0.5;
        for (const node of element.children as HTMLCollectionOf<HTMLElement>) {
          const cx = Number(node.dataset.x);
          const cy = Number(node.dataset.y);
          if (Number.isNaN(cx)) continue;
          const dx = cx - cam.x;
          const dy = cy - cam.y;
          const r = Math.hypot(dx, dy) || 0.0001;
          // The lens: near the middle a card covers less screen per step, so it lingers there.
          const near = Math.exp(-((r / lens) ** 2));
          const mapped = r * (1 - 0.42 * near);
          const sx = w / 2 + (dx / r) * mapped;
          const sy = h / 2 + (dy / r) * mapped;
          const scale = 1 + 0.8 * Math.exp(-((r / (lens * 0.62)) ** 2));
          const dim = Math.min(0.82, Math.max(0, (r - lens * 0.22) / (lens * 1.7)));
          node.style.transform = `translate3d(${sx - Number(node.dataset.w) / 2}px, ${sy - Number(node.dataset.h) / 2}px, 0) scale(${scale})`;
          node.style.zIndex = String(10_000 - Math.round(r));
          node.style.setProperty('--dim', dim.toFixed(3));
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Input: wheel and trackpad (both axes, shift for sideways), drag with momentum, arrow keys.
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const cam = camera.current;
      const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 400 : 1;
      const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
      const dy = (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit;
      cam.vx = Math.max(-60, Math.min(60, cam.vx + dx * 0.12));
      cam.vy = Math.max(-60, Math.min(60, cam.vy + dy * 0.12));
      cam.idle = 0;
      setHint(false);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], .modal-backdrop')) return;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      const cam = camera.current;
      cam.vx = move[0] * CELL_W * 0.1;
      cam.vy = move[1] * CELL_H * 0.1;
      cam.idle = 0;
      setHint(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const drag = useRef<{ x: number; y: number; moved: number; last: number; id: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, moved: 0, last: performance.now(), id: event.pointerId };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    camera.current.dragging = true;
    camera.current.vx = 0;
    camera.current.vy = 0;
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    state.moved += Math.abs(dx) + Math.abs(dy);
    const now = performance.now();
    const elapsed = Math.max(1, now - state.last);
    const cam = camera.current;
    cam.x -= dx;
    cam.y -= dy;
    cam.vx = (-dx / elapsed) * 16;
    cam.vy = (-dy / elapsed) * 16;
    cam.idle = 0;
    state.x = event.clientX;
    state.y = event.clientY;
    state.last = now;
    if (state.moved > 6) setHint(false);
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const state = drag.current;
    drag.current = null;
    camera.current.dragging = false;
    if (!state) return;
    if (performance.now() - state.last > 80) {
      camera.current.vx = 0;
      camera.current.vy = 0;
    }
    // A tap (not a drag) opens the card under the pointer.
    if (state.moved <= 6) {
      const card = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-id]');
      if (card?.dataset.id) navigate(watchPath(card.dataset.id));
    }
  };

  return (
    <div className="canvas-wrap" ref={wrap} style={{ height }}>
      <div className="canvas-header">{header}</div>
      <div
        className="canvas-plane"
        ref={plane}
        role="list"
        aria-label="Recommendations"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          // Enter opens the card in the middle.
          const cam = camera.current;
          const gy = Math.round(cam.y / CELL_H);
          const gx = Math.round((cam.x - (Math.abs(gy) % 2 === 1 ? CELL_W / 2 : 0)) / CELL_W);
          const item = itemAt(spiralIndex(gx, gy));
          if (item) navigate(watchPath(item.id));
        }}
      >
        {cells.map((cell) => {
          const item = itemAt(cell.index);
          const { w, h } = cardSize(item);
          const center = cellCenter(cell.x, cell.y);
          return (
            <div
              key={cell.key}
              className={`canvas-card ${item ? '' : 'canvas-card-empty'}`}
              role="listitem"
              data-x={center.x}
              data-y={center.y}
              data-w={w}
              data-h={h}
              data-id={item?.id}
              aria-label={item ? `${item.title}${item.creator ? `, ${item.creator.name}` : ''}` : undefined}
              style={{ width: w }}
            >
              <div className="canvas-media" style={{ height: h }}>
                {item && <Poster item={item} src={previewOf(item)} />}
              </div>
              {item && (
                <div className="canvas-info">
                  <div className="canvas-title">{item.title}</div>
                  {item.creator && <div className="canvas-creator">{item.creator.name}</div>}
                </div>
              )}
              <div className="canvas-dim" />
            </div>
          );
        })}
      </div>
      {items.length === 0 && !loading && <div className="canvas-message">{failure ? <div className="banner danger">{failure}</div> : empty}</div>}
      {loading && (
        <div className="canvas-loading">
          <Spinner /> Loading more…
        </div>
      )}
      {hint && items.length > 0 && (
        <div className="canvas-hint">
          <Move size={15} /> Scroll or drag in any direction
        </div>
      )}
    </div>
  );
}
