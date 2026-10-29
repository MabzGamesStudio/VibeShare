import { Bookmark, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HistoryItem, LibraryItem, SavedState } from '../../../src/shared/clientapi';
import { api, errorMessage } from '../api';
import { SaveCidButton } from '../components/SaveCid';
import { CopyButton, Empty, Loading } from '../components/ui';
import { useApp } from '../state';
import { formatBytes, timeAgo, watchPath } from '../util';

export function LibraryPage() {
  const { state, toast } = useApp();
  const [data, setData] = useState<{ published: LibraryItem[]; history: HistoryItem[] } | null>(null);
  const [cache, setCache] = useState<{ bytes: number; chunks: number; limit: number } | null>(null);
  const [saved, setSaved] = useState<SavedState | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [fresh, setFresh] = useState('');

  const load = () => {
    api<{ published: LibraryItem[]; history: HistoryItem[] }>('/api/library').then(setData).catch((e) => toast(errorMessage(e), 'error'));
    api<{ bytes: number; chunks: number; limit: number }>('/api/cache').then(setCache).catch(() => undefined);
    api<SavedState>('/api/saved').then(setSaved).catch(() => undefined);
  };
  useEffect(load, []);

  if (!data || !state) return <div className="page"><Loading /></div>;
  const nodeName = (id: string) => state.nodes.find((n) => n.id === id)?.name ?? id.slice(0, 10);
  const collectionName = (id: string) => saved?.collections.find((c) => c.id === id)?.name ?? id;
  const savedItems =
    filter === 'all' ? (saved?.items ?? []) : filter === 'none' ? (saved?.items ?? []).filter((item) => item.collections.length === 0) : (saved?.items ?? []).filter((item) => item.collections.includes(filter));

  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>Library</h1>
          <p>What you published and what you saved.</p>
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
          Review status on each algorithm node is shown under <Link to="/earn" className="link">Earn → Algorithm nodes</Link>.
        </p>
      </div>

      <div className="section">
        <div className="row between" style={{ marginBottom: 14 }}>
          <h2>Saved cids</h2>
          <div className="row" style={{ gap: 6 }}>
            <input
              type="text"
              placeholder="New collection"
              value={fresh}
              onChange={(e) => setFresh(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                void api<SavedState>('/api/cid-collections', { method: 'POST', body: { name: fresh.trim() } })
                  .then((state) => {
                    setSaved(state);
                    setFresh('');
                  })
                  .catch((error) => toast(errorMessage(error), 'error'));
              }}
            />
            <button
              disabled={!fresh.trim()}
              onClick={() => {
                void api<SavedState>('/api/cid-collections', { method: 'POST', body: { name: fresh.trim() } })
                  .then((state) => {
                    setSaved(state);
                    setFresh('');
                  })
                  .catch((error) => toast(errorMessage(error), 'error'));
              }}
            >
              <Plus size={15} /> Add
            </button>
          </div>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <button className={filter === 'all' ? 'small primary' : 'small'} onClick={() => setFilter('all')}>
            All ({saved?.items.length ?? 0})
          </button>
          {(saved?.collections ?? []).map((collection) => (
            <button key={collection.id} className={filter === collection.id ? 'small primary' : 'small'} onClick={() => setFilter(collection.id)}>
              {collection.name}
            </button>
          ))}
          <button className={filter === 'none' ? 'small primary' : 'small'} onClick={() => setFilter('none')}>
            Unsorted
          </button>
        </div>
        {savedItems.length === 0 ? (
          <Empty icon={<Bookmark size={36} />} title="Nothing saved here">
            <p className="small muted">Save a cid from any content with the bookmark button, and sort it into your collections.</p>
          </Empty>
        ) : (
          <div className="card">
            {savedItems.map((item) => (
              <div key={item.id} className="row between" style={{ padding: '6px 0', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <Link to={watchPath(item.id)} className="link">
                    {item.title}
                  </Link>
                  <div className="tiny faint" style={{ wordBreak: 'break-all' }}>
                    {item.id} · {timeAgo(item.addedAt)}
                  </div>
                  {item.collections.length > 0 && (
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
                      {item.collections.map((cid) => (
                        <span key={cid} className="badge">{collectionName(cid)}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <SaveCidButton id={item.id} title={item.title} className="small" compact onSaved={setSaved} />
                  <CopyButton text={item.id} label="Id" />
                  <button
                    className="small ghost icon"
                    aria-label="Take out of saved"
                    title="Take out of saved"
                    onClick={() => {
                      void api<SavedState>(`/api/saved/${encodeURIComponent(item.id)}`, { method: 'DELETE' }).then(setSaved).catch((error) => toast(errorMessage(error), 'error'));
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {(saved?.collections ?? []).length > 0 && (
          <div className="card" style={{ marginTop: 10 }}>
            <div className="hint" style={{ marginBottom: 6 }}>Collections — rename by typing in the field and clicking away.</div>
            {(saved?.collections ?? []).map((collection) => (
              <div key={collection.id} className="row between" style={{ padding: '4px 0', gap: 8 }}>
                <input
                  type="text"
                  key={collection.id + collection.name}
                  defaultValue={collection.name}
                  style={{ flex: 1 }}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (!name || name === collection.name) return;
                    void api<SavedState>(`/api/cid-collections/${collection.id}`, { method: 'PATCH', body: { name } })
                      .then(setSaved)
                      .catch((error) => {
                        toast(errorMessage(error), 'error');
                        e.target.value = collection.name;
                      });
                  }}
                />
                <button
                  className="small ghost icon"
                  aria-label="Remove collection"
                  title="Remove collection (the cids saved in it stay saved)"
                  onClick={() => {
                    void api<SavedState>(`/api/cid-collections/${collection.id}`, { method: 'DELETE' }).then(setSaved).catch((error) => toast(errorMessage(error), 'error'));
                  }}
                >
                  <Trash2 size={14} />
                </button>
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
