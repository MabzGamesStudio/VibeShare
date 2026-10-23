// What the user watched and what they searched for: two tabs, each viewable and
// clearable, on the History settings tab and the History page. How the lists come in —
// paged, or as the page is scrolled — is chosen at the top of the tab. (Settings → Seen
// decides whether the histories are kept at all, and whether the search bar suggests
// from the search history.)
import { History as HistoryIcon, Search, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { HistoryItem, SearchHistoryItem } from '../../../src/shared/clientapi';
import { api, errorMessage } from '../api';
import { Empty, Loading } from '../components/ui';
import { useApp } from '../state';
import { timeAgo, watchPath } from '../util';

const PAGE = 25;

/** The watched and searched histories, with how they are read built in. */
export function HistorySection() {
  const { state, updateSettings, toast } = useApp();
  const mode = state?.settings.historyMode === 'lazy' ? 'lazy' : 'pages';
  const [kind, setKind] = useState<'watched' | 'searches'>('watched');
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [searches, setSearches] = useState<SearchHistoryItem[] | null>(null);
  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const load = () => {
    api<{ history: HistoryItem[] }>('/api/library').then((d) => setHistory(d.history)).catch((e) => toast(errorMessage(e), 'error'));
    api<{ items: SearchHistoryItem[] }>('/api/search-history').then((d) => setSearches(d.items)).catch(() => setSearches([]));
  };
  useEffect(load, []);

  // Lazy loading brings the next page in when the last row comes into view.
  useEffect(() => {
    if (mode !== 'lazy') return;
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShown((n) => n + PAGE);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [mode, kind, history, searches]);

  if (!history || !searches) return <Loading />;

  const rows: { key: string; at: string; row: ReactNode }[] =
    kind === 'watched'
      ? history.map((item) => ({
          key: item.id,
          at: item.at,
          row: (
            <Link to={watchPath(item.id)} className="link">
              {item.title}
            </Link>
          ),
        }))
      : searches.map((item) => ({
          key: item.query,
          at: item.at,
          row: (
            <span className="row between" style={{ gap: 10, width: '100%' }}>
              <Link
                to={`/search?q=${encodeURIComponent(item.query)}`}
                className="link"
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={item.query}
              >
                {item.query}
              </Link>
              <button
                className="small ghost icon"
                title="Remove from the search history"
                aria-label="Remove from the search history"
                onClick={async () => {
                  await api('/api/search-history', { method: 'DELETE', body: { query: item.query } });
                  load();
                }}
              >
                <Trash2 size={14} />
              </button>
            </span>
          ),
        }));

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const start = mode === 'pages' ? Math.min(page, pages - 1) * PAGE : 0;
  const end = mode === 'pages' ? start + PAGE : Math.min(rows.length, shown);
  const shownRows = rows.slice(start, end);
  const clear = async () => {
    if (kind === 'watched') await api('/api/history', { method: 'DELETE' });
    else await api('/api/search-history', { method: 'DELETE', body: {} });
    setPage(0);
    setShown(PAGE);
    load();
  };

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <label className="field" style={{ marginBottom: 0 }}>
          Show history
          <select value={mode} onChange={(e) => void updateSettings({ historyMode: e.target.value as 'pages' | 'lazy' })}>
            <option value="pages">By page</option>
            <option value="lazy">As I scroll</option>
          </select>
        </label>
        <div className="tabs">
          <button className={`tab ${kind === 'watched' ? 'on' : ''}`} onClick={() => setKind('watched')}>
            <HistoryIcon size={14} /> Watched
          </button>
          <button className={`tab ${kind === 'searches' ? 'on' : ''}`} onClick={() => setKind('searches')}>
            <Search size={14} /> Searches
          </button>
        </div>
      </div>

      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="tiny faint">
          {rows.length} {kind === 'watched' ? 'watched' : 'searches'}
          {mode === 'pages' ? ` · page ${Math.min(page, pages - 1) + 1} of ${pages}` : ''}
        </span>
        {rows.length > 0 && (
          <button className="small" onClick={() => void clear()}>
            <Trash2 size={14} /> Clear
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <Empty
          icon={kind === 'watched' ? <HistoryIcon size={36} /> : <Search size={36} />}
          title={kind === 'watched' ? 'Nothing watched yet' : 'No searches yet'}
        />
      ) : (
        <div className="card">
          {shownRows.map((item) => (
            <div key={item.key} className="row between" style={{ padding: '6px 0' }}>
              {item.row}
              <span className="tiny faint">{timeAgo(item.at)}</span>
            </div>
          ))}
          {mode === 'lazy' && end < rows.length && <div ref={sentinel} style={{ height: 1 }} />}
        </div>
      )}

      {mode === 'pages' && pages > 1 && (
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <button className="small" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </button>
          <button className="small" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>
            Next
          </button>
        </div>
      )}
    </>
  );
}

export function HistoryPage() {
  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>History</h1>
          <p>What you watched and what you searched for.</p>
        </div>
      </div>
      <HistorySection />
    </div>
  );
}