import { History, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HistoryItem, LibraryItem } from '../../../src/shared/clientapi';
import { api, errorMessage } from '../api';
import { CopyButton, Empty, Loading } from '../components/ui';
import { useApp } from '../state';
import { formatBytes, timeAgo, watchPath } from '../util';

export function LibraryPage() {
  const { state, toast } = useApp();
  const [data, setData] = useState<{ published: LibraryItem[]; history: HistoryItem[] } | null>(null);
  const [cache, setCache] = useState<{ bytes: number; chunks: number; limit: number } | null>(null);

  const load = () => {
    api<{ published: LibraryItem[]; history: HistoryItem[] }>('/api/library').then(setData).catch((e) => toast(errorMessage(e), 'error'));
    api<{ bytes: number; chunks: number; limit: number }>('/api/cache').then(setCache).catch(() => undefined);
  };
  useEffect(load, []);

  if (!data || !state) return <div className="page"><Loading /></div>;
  const nodeName = (id: string) => state.nodes.find((n) => n.id === id)?.name ?? id.slice(0, 10);

  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>Library</h1>
          <p>What you published and what you watched recently.</p>
        </div>
      </div>

      <div className="section">
        <h2>Published</h2>
        {data.published.length === 0 ? (
          <Empty icon={<Upload size={36} />} title="Nothing published yet">
            <Link to="/publish" className="button primary">
              Publish something
            </Link>
          </Empty>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Hosted on</th>
                  <th>Algorithm nodes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.published.map((item) => (
                  <tr key={item.id + item.publishedAt}>
                    <td>
                      <Link to={watchPath(item.id)} className="link">
                        {item.title}
                      </Link>
                      <div className="tiny faint">
                        {timeAgo(item.publishedAt)}
                        {item.size !== undefined ? ` · ${formatBytes(item.size)}` : ''}
                        {item.native ? '' : ' · external link'}
                      </div>
                    </td>
                    <td className="small">{item.providers.map(nodeName).join(', ') || '–'}</td>
                    <td className="small">
                      {item.algorithms.map((a) => (
                        <div key={a.nodeId}>
                          {nodeName(a.nodeId)}: {a.error ? <span className="badge danger">{a.error}</span> : <span className="badge">submitted</span>}
                        </div>
                      ))}
                    </td>
                    <td>
                      <CopyButton text={item.id} label="Id" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Review status on each algorithm node is shown under <Link to="/earn" className="link">Earn → Contributions</Link>.
        </p>
      </div>

      <div className="section">
        <div className="row between" style={{ marginBottom: 14 }}>
          <h2>History</h2>
          {data.history.length > 0 && (
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
        {data.history.length === 0 ? (
          <Empty icon={<History size={36} />} title="No history" />
        ) : (
          <div className="card">
            {data.history.slice(0, 60).map((item) => (
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

      {cache && (
        <div className="section">
          <h2>Cache</h2>
          <div className="card row between">
            <div>
              <div>
                {formatBytes(cache.bytes)} of {formatBytes(cache.limit)} ({cache.chunks} chunks)
              </div>
              <div className="hint">Downloaded chunks are kept so rewatching and seeking cost no credits.</div>
            </div>
            <button
              onClick={async () => {
                await api('/api/cache', { method: 'DELETE' });
                load();
              }}
            >
              <Trash2 size={15} /> Clear cache
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
