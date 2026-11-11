import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Subscription } from '../../../src/shared/clientapi';
import { useApp } from '../state';
import { profilePath } from '../util';
import { Avatar } from './ui';

/**
 * The creators you follow, as a carousel. The first button on the left is "all
 * subscriptions": it opens the page where every subscription is listed, searched
 * through, removed and added.
 */
export function SubsCarousel({ subscriptions }: { subscriptions: Subscription[] }) {
  const { state } = useApp();
  const order = state?.settings.subscriptionOrder ?? 'subscribed';
  // Random reshuffles once per page load: the tiles keep their places while the page is
  // open, and every load draws a new order.
  const salt = useMemo(() => Math.random().toString(36).slice(2), []);
  // The order the carousel shows its tiles in: subscribed date by default, anything else
  // from the settings.
  const ordered = useMemo(() => {
    const byId = (id: string) => {
      let hash = 0;
      for (const char of id + salt) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      return hash;
    };
    const list = [...subscriptions];
    if (order === 'az') return list.sort((a, b) => a.name.localeCompare(b.name));
    if (order === 'za') return list.sort((a, b) => b.name.localeCompare(a.name));
    if (order === 'recent') {
      // Newest post first — the order the subscribers' content appears on the page below —
      // and the creators with nothing on that page last.
      const time = (entry: Subscription) => (entry.lastPostAt ? Date.parse(entry.lastPostAt) || 0 : 0);
      return list.sort((a, b) => time(b) - time(a));
    }
    if (order === 'random') return list.sort((a, b) => byId(a.id) - byId(b.id));
    return list.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
  }, [subscriptions, order, salt]);
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    setEdges({
      start: row.scrollLeft <= 2,
      end: row.scrollLeft + row.clientWidth >= row.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, subscriptions.length]);

  const nudge = (direction: -1 | 1) => {
    const row = rowRef.current;
    if (!row) return;
    row.scrollBy({ left: direction * Math.max(240, row.clientWidth * 0.8), behavior: 'smooth' });
  };

  return (
    <div className="carousel">
      {!edges.start && (
        <button type="button" className="carousel-arrow left" aria-label="Scroll subscriptions left" onClick={() => nudge(-1)}>
          <ChevronLeft size={18} />
        </button>
      )}
      <div className="carousel-row" ref={rowRef} onScroll={measure}>
        <Link to="/subscriptions/all" className="carousel-tile view-all" aria-label="View all subscriptions">
          <span className="carousel-avatar">
            <LayoutGrid size={22} />
          </span>
          <span className="carousel-name">All</span>
        </Link>
        {ordered.map((subscription) => (
          <Link key={subscription.id} to={profilePath(subscription.kind, subscription.id)} className="carousel-tile" aria-label={subscription.name}>
            <Avatar name={subscription.name} id={subscription.id} icon={subscription.icon} />
            <span className="carousel-name">{subscription.name}</span>
          </Link>
        ))}
      </div>
      {!edges.end && (
        <button type="button" className="carousel-arrow right" aria-label="Scroll subscriptions right" onClick={() => nudge(1)}>
          <ChevronRight size={18} />
        </button>
      )}
    </div>
  );
}
