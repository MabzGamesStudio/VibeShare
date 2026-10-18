// What the user watched and what they searched for: both histories on one page, each
// viewable and clearable. (Settings → Seen decides whether they are kept at all, and
// whether the search bar suggests from the search history.)
import { History as HistoryIcon, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HistoryItem, SearchHistoryItem } from '../../../src/shared/clientapi';
import { api, errorMessage } from '../api';
import { Empty, Loading } from '../components/ui';
import { useApp } from '../state';
import { timeAgo, watchPath } from '../util';

export function HistoryPage() {
  const { toast } = useApp();
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [searches, setSearches] = useState<SearchHistoryItem[] | null>(null);

  const load = () => {
    api<{ history: HistoryItem[] }>('/api/library').then((d) => setHistory(d.history)).catch((e) => toast(errorMessage(e), 'error'));
    api<{ items: SearchHistoryItem[] }>('/api/search-history').then((d) => setSearches(d.items)).catch(() => setSearches([]));
  };
  useEffect(load, []);

  if (!history || !searches) return <div className="page"><Loading /></div>;

  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>History</h1>
          <p>What you watched and what you searched for.</p>
        </div>
      </div>

      <div className="section">
        <div className="row between" style={{ marginBottom: 14 }}>
          <h2>Watched</h2>
          {history.length > 0 && (
            <button
              className="small"
              onClick={async () => {
                await api('/api/history', { method: 'DELETE' });
                load();
              }}
            >
              <Trash2 size={14} /> Clear
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <Empty icon={<HistoryIcon size={36} />} title="Nothing watched yet" />
        ) : (
          <div className="card">
            {history.slice(0, 60).map((item) => (
              <div key={item.id} className="row between" style={{ padding: '6px 0' }}>
                <Link to={watchPath(item.id)} className="link">
                  {item.title}
                </Link>
                <span className="tiny faint">{timeAgo(item.at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <div className="row between" style={{ marginBottom: 14 }}>
          <h2>Searches</h2>
          {searches.length > 0 && (
            <button
              className="small"
              onClick={async () => {
                await api('/api/search-history', { method: 'DELETE', body: {} });
                load();
              }}
            >
              <Trash2 size={14} /> Clear
            </button>
          )}
        </div>
        {searches.length === 0 ? (
          <Empty icon={<Search size={36} />} title="No searches yet" />
        ) : (
          <div className="card">
            {searches.slice(0, 60).map((item) => (
              <div key={item.query} className="row between" style={{ padding: '6px 0', gap: 10 }}>
                <Link
                  to={`/search?q=${encodeURIComponent(item.query)}`}
                  className="link"
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={item.query}
                >
                  {item.query}
                </Link>
                <span className="row" style={{ gap: 8, flexShrink: 0 }}>
                  <span className="tiny faint">{timeAgo(item.at)}</span>
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
              </div>
            ))}
          </div>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Keeping this history and suggesting it under the search box are toggled in{' '}
          <Link to="/settings#history" className="link">
            Settings → Seen
          </Link>
          .
        </p>
      </div>
    </div>
  );
}