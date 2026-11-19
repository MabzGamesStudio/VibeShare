// The delete review queue: content removal requests clients sent that need the
// operator's verdict. The same panel serves both consoles — approve deletes the
// content the node's own way, reject dismisses the request.
import { useCallback, useEffect, useState } from 'react';
import type { RemovalRequestView } from '../../../src/shared/protocol';
import { Loading, Modal } from '../components/ui';
import { timeAgo } from '../util';
import { admin, message } from './api';
import { ListControls, Pager, Sentinel, useConsoleList } from './paging';

export function DeleteReview({ base = '/v1/admin/removals', onChanged }: { base?: string; onChanged?: () => void }) {
  const [rows, setRows] = useState<RemovalRequestView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [viewing, setViewing] = useState<RemovalRequestView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { prefs, save } = useConsoleList('delete-review');
  const perPage = prefs.perPage;
  const lazy = prefs.paging === 'lazy';

  const fetchPage = useCallback(
    (offset: number, append: boolean) => {
      setLoading(true);
      admin<{ items: RemovalRequestView[]; total: number }>(`${base}?offset=${offset}&limit=${perPage}`)
        .then((r) => {
          setRows((current) => (append ? [...(current ?? []), ...r.items] : r.items));
          setTotal(r.total);
          setLoading(false);
        })
        .catch((e) => {
          setToast(message(e));
          setLoading(false);
        });
    },
    [base, perPage]
  );
  useEffect(() => {
    setRows(null);
    fetchPage(lazy ? 0 : page * perPage, false);
  }, [fetchPage, lazy, page]);

  /** Approve deletes the content (with a confirmation); reject just dismisses the ask. */
  const decide = async (request: RemovalRequestView, approve: boolean) => {
    if (approve && !window.confirm(`Approve the removal of “${request.title ?? request.cid}”? The content is deleted from this node.`)) return;
    setBusy(request.id);
    try {
      await admin(`${base}/${request.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST' });
      setToast(approve ? 'The content was deleted.' : 'The request was dismissed.');
      onChanged?.();
      setRows(null);
      fetchPage(lazy ? 0 : page * perPage, false);
    } catch (e) {
      setToast(message(e));
    } finally {
      setBusy(null);
    }
  };

  const pager = rows && rows.length > 0 && !lazy && <Pager page={page} perPage={perPage} total={total} loading={loading} go={setPage} />;

  return (
    <div className="form-stack">
      <div>
        <h2>Delete review</h2>
        <p className="small muted">
          Removal requests clients sent for content they do not own — the requester's message is on each row. Approve deletes the content
          from this node; reject leaves it be.
        </p>
      </div>
      <div className="row">
        <ListControls prefs={prefs} save={save} />
        <div className="spacer" />
      </div>
      {toast && <div className="banner info small">{toast}</div>}
      {pager}
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="small muted">No removal requests are waiting.</p>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Content</th>
                <th>Requested by</th>
                <th>Message</th>
                <th>When</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((request) => (
                <tr key={request.id}>
                  <td>
                    {request.title ?? <span className="muted">(untitled)</span>}
                    <div className="tiny mono muted">{request.cid}</div>
                  </td>
                  <td className="mono tiny">{request.account}</td>
                  <td className="small">{request.message ?? <span className="muted">—</span>}</td>
                  <td className="tiny muted">{timeAgo(request.at)}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="small" onClick={() => setViewing(request)}>
                        View
                      </button>
                      <button className="small" disabled={busy === request.id} onClick={() => void decide(request, true)}>
                        Approve
                      </button>
                      <button className="small" disabled={busy === request.id} onClick={() => void decide(request, false)}>
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lazy && rows && rows.length < total && <Sentinel onMore={() => fetchPage(rows.length, true)} done={rows.length >= total} />}
      {pager}
      {viewing && (
        <Modal title="Removal request" onClose={() => setViewing(null)}>
          <div className="form-stack">
            <div className="field" style={{ marginBottom: 0 }}>
              <span className="hint">Content</span>
              <span>{viewing.title ?? <span className="muted">(untitled)</span>}</span>
              <code className="tiny">{viewing.cid}</code>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <span className="hint">Creator</span>
              <span>{viewing.creator ?? '—'}</span>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <span className="hint">Requested by</span>
              <code className="tiny">{viewing.account}</code>
              <span className="hint">{timeAgo(viewing.at)}</span>
            </div>
            {viewing.message && (
              <div className="field" style={{ marginBottom: 0 }}>
                <span className="hint">Message</span>
                <p className="small" style={{ margin: 0 }}>
                  {viewing.message}
                </p>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
