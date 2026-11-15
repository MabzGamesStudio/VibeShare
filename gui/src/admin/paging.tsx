// Console list controls shared by the node dashboards: lazy loading or pagination, the
// page size, and the Previous / Next pager shown above and below the list.
import { useEffect, useRef, useState } from 'react';
import { admin } from './api';

export type Paging = { paging: 'lazy' | 'pages'; perPage: number };

/** The operator's choice for one console list: lazy loading or pagination, and page size. */
export function useConsoleList(what: string) {
  const [prefs, setPrefs] = useState<Paging>({ paging: 'lazy', perPage: 50 });
  useEffect(() => {
    admin<{ console?: Record<string, Paging> }>('/v1/admin/config')
      .then((c) => setPrefs(c.console?.[what] ?? { paging: 'lazy', perPage: 50 }))
      .catch(() => undefined);
  }, [what]);
  const save = (patch: Partial<Paging>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    void admin('/v1/admin/config', { method: 'PUT', body: { console: { [what]: next } } }).catch(() => undefined);
  };
  return { prefs, save };
}

/** The page size of a console list. */
export function PageSize({ prefs, save }: { prefs: Paging; save: (patch: Partial<Paging>) => void }) {
  return (
    <div className="row">
      <input
        key={prefs.perPage}
        type="number"
        min={5}
        max={500}
        style={{ maxWidth: 92 }}
        defaultValue={prefs.perPage}
        onBlur={(e) => {
          const perPage = Math.round(Number(e.target.value));
          if (Number.isFinite(perPage) && perPage >= 5 && perPage <= 500 && perPage !== prefs.perPage) save({ perPage });
        }}
      />
      <span className="hint">items per page</span>
    </div>
  );
}

/** The mode switch and page size of one console list (kept in the node's settings). */
export function ListControls({ prefs, save }: { prefs: Paging; save: (patch: Partial<Paging>) => void }) {
  return (
    <div className="row">
      <select value={prefs.paging} style={{ width: 'auto' }} onChange={(e) => save({ paging: e.target.value as Paging['paging'] })}>
        <option value="lazy">Lazy loading</option>
        <option value="pages">Pagination</option>
      </select>
      <PageSize prefs={prefs} save={save} />
    </div>
  );
}

/** Asks for more when it scrolls into view (lazy loading). */
export function Sentinel({ onMore, done }: { onMore: () => void; done: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const element = ref.current;
    if (!element || done) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && more.current(), {
      rootMargin: '200px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [done]);
  return <div ref={ref} />;
}

/** The Previous / Next row of a paginated console list (with the page number). */
export function Pager({ page, perPage, total, loading, go }: { page: number; perPage: number; total: number; loading: boolean; go: (page: number) => void }) {
  const [wanted, setWanted] = useState('');
  const pages = Math.max(1, Math.ceil(total / perPage));
  // Skipping straight to a page: the typed number is clamped to the pages there are and
  // committed on Go or Enter. Re-sending the wanted page is cheap for every list here,
  // so no attempt is made to track typing between the keystrokes.
  const skip = () => {
    const typed = Number(wanted);
    if (!wanted.trim() || !Number.isFinite(typed)) return;
    const target = Math.min(pages, Math.max(1, Math.round(typed))) - 1;
    setWanted('');
    if (target !== page) go(target);
  };
  return (
    <div className="row">
      <button className="small" disabled={page === 0 || loading} onClick={() => go(page - 1)}>
        Previous
      </button>
      <span className="small">
        Page {page + 1} of {pages}
      </span>
      <button className="small" disabled={(page + 1) * perPage >= total || loading} onClick={() => go(page + 1)}>
        Next
      </button>
      {pages > 1 && (
        <>
          <div className="spacer" />
          <span className="tiny muted">Skip to</span>
          <input
            type="number"
            min={1}
            max={pages}
            placeholder="page"
            style={{ maxWidth: 72 }}
            value={wanted}
            disabled={loading}
            onChange={(e) => setWanted(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') skip();
            }}
          />
          <button className="small" disabled={loading || !wanted.trim()} onClick={skip}>
            Go
          </button>
        </>
      )}
    </div>
  );
}