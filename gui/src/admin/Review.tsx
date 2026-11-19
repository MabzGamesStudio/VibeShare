// The provider's review queue: content pushed from outside (client uploads, peer
// pushes) waits here until the operator accepts it into the catalog — or rejects it,
// which deletes the content and everything under it. What the trusted algorithm nodes
// already list is accepted here automatically, by hand or on a schedule.
import { useCallback, useEffect, useState } from 'react';
import { Loading, Spinner } from '../components/ui';
import { formatBytes, timeAgo } from '../util';
import { admin, message } from './api';
import { ListControls, Pager, Sentinel, useConsoleList } from './paging';
import { useToast } from './AdminApp';

interface ReviewRow {
  cid: string;
  name: string;
  mime: string;
  size: number;
  chunks: number;
  title?: string;
  uploader: string;
  createdAt: string;
}

export function Review({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<ReviewRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [review, setReview] = useState<{ enabled: boolean; syncMinutes: number } | null>(null);
  const [minutes, setMinutes] = useState('');
  const [toast, show] = useToast();
  const { prefs, save: savePaging } = useConsoleList('review');

  const fetchAt = useCallback(
    async (offset: number, append: boolean) => {
      setLoading(true);
      try {
        const r = await admin<{ items: ReviewRow[]; total: number }>(`/v1/admin/content/review?offset=${offset}&limit=${prefs.perPage}`);
        setItems((current) => (append && current ? [...current, ...r.items] : r.items));
        setTotal(r.total ?? 0);
      } catch (e) {
        show(message(e));
      } finally {
        setLoading(false);
      }
    },
    [prefs.perPage, show]
  );
  useEffect(() => {
    setPage(0);
    void fetchAt(0, false);
  }, [fetchAt]);
  useEffect(() => {
    admin<{ review: { enabled: boolean; syncMinutes: number } }>('/v1/admin/config')
      .then((config) => {
        setReview(config.review);
        setMinutes(config.review?.syncMinutes ? String(config.review.syncMinutes) : '');
      })
      .catch((e) => show(message(e)));
  }, [show]);

  const reload = () => {
    onChanged();
    setPage(0);
    void fetchAt(0, false);
  };

  const verdict = async (row: ReviewRow, accept: boolean) => {
    const what = row.title ?? row.name;
    if (!accept && !window.confirm(`Reject "${what}"? Its content and bytes are deleted.`)) return;
    setBusy(row.cid);
    try {
      await admin(`/v1/admin/content/${encodeURIComponent(row.cid)}/${accept ? 'accept' : 'reject'}`, {
        method: 'POST',
        body: accept ? {} : { reason: 'rejected by operator' },
      });
      show(accept ? `Accepted ${what}` : `Rejected ${what}`);
      reload();
    } catch (e) {
      show(message(e));
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const result = await admin<{ checked: number; accepted: number; errors: number }>('/v1/admin/content/review/sync', {
        method: 'POST',
        body: {},
      });
      show(`Checked ${result.checked}, accepted ${result.accepted}${result.errors ? `, ${result.errors} errors` : ''}`);
      reload();
    } catch (e) {
      show(message(e));
    } finally {
      setSyncing(false);
    }
  };

  const saveMinutes = async () => {
    const syncMinutes = Math.max(0, Math.floor(Number(minutes) || 0));
    setMinutes(syncMinutes ? String(syncMinutes) : '');
    try {
      const config = await admin<{ review: { enabled: boolean; syncMinutes: number } }>('/v1/admin/config', {
        method: 'PUT',
        body: { review: { enabled: review?.enabled ?? true, syncMinutes } },
      });
      setReview(config.review);
      show(syncMinutes ? `The queue is synced every ${syncMinutes} minutes` : 'The automatic sync is off');
    } catch (e) {
      show(message(e));
    }
  };

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Review</h3>
        <p className="small muted">
          Content pushed to this node — client uploads and peer pushes — waits here until it is accepted into the
          catalog. Accepted content becomes visible, served and given its storage job; rejected content and its bytes
          are deleted. What the trusted algorithm nodes already list has been reviewed there and is accepted here.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="small" disabled={syncing} onClick={() => void syncNow()}>
            {syncing ? <Spinner /> : 'Check algorithm nodes'}
          </button>
          <label className="row small" style={{ gap: 4 }}>
            Sync automatically every
            <input
              type="number"
              min={0}
              value={minutes}
              placeholder="0"
              style={{ width: 70 }}
              onChange={(e) => setMinutes(e.target.value)}
              onBlur={() => void saveMinutes()}
            />
            minutes (0 = only by hand)
          </label>
        </div>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="tiny faint">
            {total} item{total === 1 ? '' : 's'} waiting for review
          </span>
          <ListControls prefs={prefs} save={savePaging} />
        </div>
      </div>
      {prefs.paging === 'pages' && items && (
        <Pager
          page={page}
          perPage={prefs.perPage}
          total={total}
          loading={loading}
          go={(next) => {
            setPage(next);
            void fetchAt(next * prefs.perPage, false);
          }}
        />
      )}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Content</th>
              <th>Size</th>
              <th>Pushed by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items === null ? (
              <tr>
                <td colSpan={4}>
                  <Loading />
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={4} className="small muted">
                  Nothing is waiting for review.
                </td>
              </tr>
            ) : (
              items.map((row) => (
                <tr key={row.cid}>
                  <td>
                    <strong>{row.title ?? row.name}</strong>
                    <div className="tiny faint">
                      {row.mime} · {row.chunks} chunk{row.chunks === 1 ? '' : 's'} · {timeAgo(row.createdAt)}
                    </div>
                    <div className="mono tiny faint" title={row.cid}>
                      {row.cid.slice(-8)}
                    </div>
                  </td>
                  <td className="small">{formatBytes(row.size)}</td>
                  <td className="mono tiny faint">{row.uploader}</td>
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button className="small" disabled={busy === row.cid} onClick={() => void verdict(row, true)}>
                        {busy === row.cid ? <Spinner /> : 'Accept'}
                      </button>
                      <button className="small danger" disabled={busy === row.cid} onClick={() => void verdict(row, false)}>
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {prefs.paging === 'lazy' && items && <Sentinel onMore={() => void fetchAt(items.length, true)} done={items.length >= total} />}
    </div>
  );
}
