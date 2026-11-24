import { LayoutGrid } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CreatorView, Subscription } from '../../../src/shared/clientapi';
import { api } from '../api';
import { useApp } from '../state';
import { profilePath } from '../util';
import { Avatar } from './ui';

// The icons the subscription records do not all keep, looked up one creator at a time
// (the creator search only answers a handful of ids at once, so one batch lookup misses
// most of a long list) and cached for the session — "has none" included, so a re-render
// or the next mount never repeats a lookup.
const iconCache = new Map<string, string | null>();
const iconLoads = new Map<string, Promise<string | null>>();

/** One creator's icon, fetched at most once per session; null when the creator has none. */
function loadIcon(id: string): Promise<string | null> {
  const cached = iconCache.get(id);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = iconLoads.get(id);
  if (running) return running;
  const load = api<CreatorView>(`/api/creators/${encodeURIComponent(id)}`)
    .then((view) => {
      const icon = view.creator?.icon || null;
      iconCache.set(id, icon);
      return icon;
    })
    // A failed lookup is not remembered: the next page load may find better luck.
    .catch(() => null)
    .finally(() => iconLoads.delete(id));
  iconLoads.set(id, load);
  return load;
}

/**
 * The creators you follow, as a carousel. The first button on the left is "all
 * subscriptions": it opens the page where every subscription is listed, searched
 * through, removed and added. A tile shows the creator's icon when there is one and
 * falls back to the letter avatar.
 */
export function SubsCarousel({ subscriptions }: { subscriptions: Subscription[] }) {
  const { state } = useApp();
  const order = state?.settings.subscriptionOrder ?? 'subscribed';
  // Creator icons the subscription records do not all keep: the missing ones are fetched
  // a few at a time from the session cache's worker pool. Anything arriving after this
  // carousel goes away is ignored (the cache keeps it for the next mount).
  const [icons, setIcons] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    const wanted = [...new Set(subscriptions.filter((subscription) => !subscription.icon).map((subscription) => subscription.id))];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (live && next < wanted.length) {
        const id = wanted[next++];
        const icon = await loadIcon(id);
        if (!live) return;
        if (icon) {
          setIcons((old) => (old.get(id) === icon ? old : new Map(old).set(id, icon)));
          // Cache it on the subscription record as well: the next visit renders the icon
          // at once, without asking the nodes again (the session map stays the fallback).
          void api(`/api/subscriptions/${encodeURIComponent(id)}`, { method: 'PATCH', body: { icon } }).catch(() => undefined);
        }
      }
    };
    // A small pool, not one request per tile: a long subscription list stays polite.
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => {
      live = false;
    };
  }, [subscriptions]);
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
  return (
    <div className="carousel">
      <div className="carousel-row">
        <Link to="/subscriptions/all" className="carousel-tile view-all" aria-label="View all subscriptions">
          <span className="carousel-avatar">
            <LayoutGrid size={22} />
          </span>
          <span className="carousel-name">All</span>
        </Link>
        {ordered.map((subscription) => (
          <Link key={subscription.id} to={profilePath(subscription.kind, subscription.id)} className="carousel-tile" aria-label={subscription.name}>
            <Avatar name={subscription.name} id={subscription.id} icon={subscription.icon ?? icons.get(subscription.id)} />
            <span className="carousel-name">{subscription.name}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
