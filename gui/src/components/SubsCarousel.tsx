import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Subscription } from '../../../src/shared/clientapi';
import { creatorPath } from '../util';
import { Avatar } from './ui';

/**
 * The creators you follow, as a carousel. The first button on the left is "all
 * subscriptions": it opens the page where every subscription is listed, searched
 * through, removed and added.
 */
export function SubsCarousel({ subscriptions }: { subscriptions: Subscription[] }) {
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
        {subscriptions.map((subscription) => (
          <Link key={subscription.id} to={creatorPath(subscription.id)} className="carousel-tile" aria-label={subscription.name}>
            <Avatar name={subscription.name} id={subscription.id} />
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
