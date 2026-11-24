import { Bookmark, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HistoryItem, LibraryItem, SavedState } from '../../../src/shared/clientapi';
import { api, errorMessage } from '../api';
import { RemovalModal } from '../components/RequestRemoval';
import { SaveCidButton } from '../components/SaveCid';
import { CopyButton, Empty, Loading } from '../components/ui';
import { useApp } from '../state';
import { formatBytes, timeAgo, watchPath } from '../util';

const PAGE = 25;

interface Pager {
  mode: 'pages' | 'lazy';
  setMode: (mode: 'pages' | 'lazy') => void;
  page: number;
  setPage: (update: (page: number) => number) => void;
  setShown: (update: (shown: number) => number) => void;
  sentinel: React.RefObject<HTMLDivElement | null>;
  pages: number;
  start: number;
  end: number;
}

/** How one list loads: a page at a time, or as the inner card is scrolled. */
function usePager(total: number): Pager {
  const [mode, setMode] = useState<'pages' | 'lazy'>('pages');
  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (mode !== 'lazy') return;
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShown((n) => n + PAGE);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [mode, total]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const start = mode === 'pages' ? Math.min(page, pages - 1) * PAGE : 0;
  const end = mode === 'pages' ? start + PAGE : Math.min(total, shown);
  return { mode, setMode, page, setPage, setShown, sentinel, pages, start, end };
}

function PagerBar({ pager, total }: { pager: Pager; total: number }) {
  return (
    <div className="row between" style={{ marginBottom: 8 }}>
      <span className="tiny faint">
        {total} items{pager.mode === 'pages' ? ` · page ${Math.min(pager.page, pager.pages - 1) + 1} of ${pager.pages}` : ''}
      </span>
      <select
        className="small"
        value={pager.mode}
        aria-label="How the list loads"
        onChange={(e) => {
          pager.setMode(e.target.value as 'pages' | 'lazy');
          pager.setPage(() => 0);
          pager.setShown(() => PAGE);
        }}
      >
        <option value="pages">By page</option>
        <option value="lazy">As I scroll</option>
      </select>
    </div>
  );
}

function PagerNav({ pager }: { pager: Pager }) {
  if (pager.mode !== 'pages' || pager.pages <= 1) return null;
  return (
    <div className="row" style={{ marginTop: 8, gap: 8 }}>
      <button className="small" disabled={pager.page <= 0} onClick={() => pager.setPage((p) => Math.max(0, p - 1))}>
        Previous
      </button>
      <button className="small" disabled={pager.page >= pager.pages - 1} onClick={() => pager.setPage((p) => Math.min(pager.pages - 1, p + 1))}>
        Next
      </button>
    </div>
  );
}

/** One row's removal actions: gone from this device, or requested gone from the nodes. */
function RemovalButtons({ onDelete, onRemove }: { onDelete: () => void; onRemove: () => void }) {
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <button className="small" onClick={onDelete} title="Take it out of this library and delete its cached content on this device">
        Delete locally
      </button>
      <button className="small" onClick={onRemove} title="Ask the nodes that hold or list it to remove or hide it">
        Request removal
      </button>
    </div>
  );
}

export function LibraryPage() {
  const { state, toast } = useApp();
  const [data, setData] = useState<{ published: LibraryItem[]; history: HistoryItem[] } | null>(null);
  const [cache, setCache] = useState<{ bytes: number; chunks: number; limit: number } | null>(null);
  const [saved, setSaved] = useState<SavedState | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [fresh, setFresh] = useState('');
  const [removal, setRemoval] = useState<{ id: string; title: string } | null>(null);

  const load = () => {
    api<{ published: LibraryItem[]; history: HistoryItem[] }>('/api/library').then(setData).catch((e) => toast(errorMessage(e), 'error'));
    api<{ bytes: number; chunks: number; limit: number }>('/api/cache').then(setCache).catch(() => undefined);
    api<SavedState>('/api/saved').then(setSaved).catch(() => undefined);
  };
  useEffect(load, []);

  /** "Delete locally": out of the library and out of the cache — the content itself stays. */
  const deleteLocally = async (item: { id: string; title: string }, from: 'saved' | 'published') => {
    if (!window.confirm(`Delete "${item.title}" from this device? It leaves your library and its cached content is deleted. The content itself stays where it is published.`)) return;
    try {
      await api(`/api/cache/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (from === 'saved') await api(`/api/saved/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      else await api(`/api/library/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      load();
      toast('Deleted from this device', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const savedItems =
    filter === 'all' ? (saved?.items ?? []) : filter === 'none' ? (saved?.items ?? []).filter((item) => item.collections.length === 0) : (saved?.items ?? []).filter((item) => item.collections.includes(filter));
  const publishedPager = usePager(data?.published.length ?? 0);
  const savedPager = usePager(savedItems.length);

  if (!data || !state) return <div className="page"><Loading /></div>;
  const nodeName = (id: string) => state.nodes.find((n) => n.id === id)?.name ?? id.slice(0, 10);
  const collectionName = (id: string) => saved?.collections.find((c) => c.id === id)?.name ?? id;

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
          <>
          <PagerBar pager={publishedPager} total={data.published.length} />
          <div className="card" style={{ padding: 0, maxHeight: 420, overflowY: 'auto' }}>
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
                {data.published.slice(publishedPager.start, publishedPager.end).map((item) => (
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
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <CopyButton text={item.id} label="Id" />
                        <RemovalButtons
                          onDelete={() => void deleteLocally(item, 'published')}
                          onRemove={() => setRemoval({ id: item.id, title: item.title })}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {publishedPager.mode === 'lazy' && publishedPager.end < data.published.length && (
              <div ref={publishedPager.sentinel} style={{ height: 1 }} />
            )}
          </div>
          <PagerNav pager={publishedPager} />
          </>
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
        </div>
        {savedItems.length === 0 ? (
          <Empty icon={<Bookmark size={36} />} title="Nothing saved here">
            <p className="small muted">Save a cid from any content with the bookmark button, and sort it into your collections.</p>
          </Empty>
        ) : (
          <>
          <PagerBar pager={savedPager} total={savedItems.length} />
          <div className="card" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {savedItems.slice(savedPager.start, savedPager.end).map((item) => (
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
                <div className="row" style={{ gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
                  <RemovalButtons
                    onDelete={() => void deleteLocally(item, 'saved')}
                    onRemove={() => setRemoval({ id: item.id, title: item.title })}
                  />
                </div>
              </div>
            ))}
            {savedPager.mode === 'lazy' && savedPager.end < savedItems.length && <div ref={savedPager.sentinel} style={{ height: 1 }} />}
          </div>
          <PagerNav pager={savedPager} />
          </>
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
      {removal && <RemovalModal target={removal} onClose={() => setRemoval(null)} />}
    </div>
  );
}
