// Manual content sync: the operator names content provider nodes and this node's full
// catalog — every content's manifest and all of its chunks — goes to each of them. The
// walk over the catalog happens here (one content to one target per call) so every
// target has a live progress row, and an interrupted run only needs re-sending what that
// target is still missing: the node asks the target what it has before every push.

import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../components/ui';
import { formatBytes } from '../util';
import { admin, message } from './api';
import { formatNodeRef, parseNodeRefs, type NodeRef } from '../../../src/shared/noderef.js';
import { useToast } from './AdminApp';

interface PushItemResult {
  sent: number;
  skipped: number;
  missing: number;
  bytes: number;
  manifest: boolean;
  error?: string;
}

type RowStatus = 'queued' | 'running' | 'done' | 'failed';

/** One target node and everything its sync has moved so far. */
interface SyncRow {
  /** The node reference the push calls send (the row's key). */
  ref: string;
  status: RowStatus;
  /** Contents handled so far; also where a stopped run continues from. */
  done: number;
  /** Contents in the catalog when the run started. */
  total: number;
  sent: number;
  skipped: number;
  missing: number;
  bytes: number;
  error?: string;
}

/** The row's name: the pinned reference, or the plain URL when no key pins the node. */
function refLabel(ref: NodeRef): string {
  return ref.type && ref.id ? formatNodeRef({ type: ref.type, id: ref.id, url: ref.url }) : ref.url;
}

export function ManualContentSync() {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<SyncRow[]>([]);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [toast, show] = useToast();
  // Loops stop when the card goes away: nobody is left updating an unmounted view.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const running = rows.some((row) => row.status === 'running' || row.status === 'queued');

  const update = (row: SyncRow, changes: Partial<SyncRow>) => {
    Object.assign(row, changes);
    if (!alive.current) return;
    setRows((prev) => prev.map((entry) => (entry.ref === row.ref ? { ...row } : entry)));
  };

  // One row's walk of the catalog. The catalog is paged as the walk goes (never held in
  // the browser whole), and every call only uploads what the target lacks, so re-running
  // any part of it is cheap and idempotent — that is what makes Continue work.
  const run = async (row: SyncRow, from: number) => {
    update(row, { status: 'running', done: from, error: undefined });
    let index = from;
    let sent = row.sent;
    let skipped = row.skipped;
    let missing = row.missing;
    let bytes = row.bytes;
    try {
      for (;;) {
        const page = await admin<{ items: { cid: string }[]; total: number }>(`/v1/admin/content?offset=${index}&limit=100`);
        if (!alive.current) return;
        update(row, { total: page.total });
        if (!page.items.length) break;
        for (const item of page.items) {
          if (!alive.current) return;
          const pushed = await admin<PushItemResult>('/v1/admin/peers/push-item', { body: { ref: row.ref, cid: item.cid } });
          if (!alive.current) return;
          sent += pushed.sent;
          skipped += pushed.skipped;
          missing += pushed.missing;
          bytes += pushed.bytes;
          if (pushed.error) {
            // The target refused or the transfer broke: show why and stop on this very
            // content, so Continue picks up exactly here.
            update(row, { sent, skipped, missing, bytes, done: index, status: 'failed', error: pushed.error });
            return;
          }
          index++;
          update(row, { sent, skipped, missing, bytes, done: index });
        }
        if (page.items.length < 100) break;
      }
      update(row, { sent, skipped, missing, bytes, done: index, status: 'done' });
    } catch (error) {
      if (!alive.current) return;
      update(row, { sent, skipped, missing, bytes, done: index, status: 'failed', error: message(error) });
    }
  };

  // A stopped run continues at the content it stopped on; a finished run checks the whole
  // catalog again, which only sends what the target lost or never got (its gaps).
  const resume = (row: SyncRow) => void run(row, row.status === 'failed' ? row.done : 0);

  const start = () => {
    const { refs, invalid: bad } = parseNodeRefs(text);
    setInvalid(bad);
    if (!refs.length) return;
    // One row per entered provider, keyed by the canonical reference: the same target
    // pasted twice syncs once.
    const fresh: SyncRow[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = refLabel(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({ ref: key, status: 'queued', done: 0, total: 0, sent: 0, skipped: 0, missing: 0, bytes: 0 });
    }
    setRows(fresh);
    show(`Sending the full catalog to ${fresh.length} provider${fresh.length === 1 ? '' : 's'}`);
    for (const row of fresh) void run(row, 0);
  };

  return (
    <div className="card form-stack">
      <h3>Manual content sync</h3>
      <p className="small muted">
        Send this node's full catalog — every content's manifest and all of its chunks — to other content provider nodes. Each target must
        have this node among its peers and accept pushed content; a push it refuses shows on the row. Only what a target is missing is
        uploaded, so an interrupted sync can simply be continued.
      </p>
      <label className="field">
        Content provider nodes
        <textarea
          className="mono"
          rows={3}
          placeholder={'vs:provider:vk1…@https://other.example.org\nhttps://other.example.org'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
      </label>
      <div className="hint">One reference per line, or separated by spaces or commas.</div>
      {invalid.length > 0 && <div className="banner warn small">Not node references: {invalid.join(', ')}</div>}
      <div className="row">
        <button className="primary" onClick={start} disabled={running || !text.trim()}>
          Send full catalog to these providers
        </button>
        {rows.some((row) => row.status === 'done' || row.status === 'failed') && (
          <button onClick={() => rows.filter((row) => row.status !== 'running' && row.status !== 'queued').forEach(resume)}>
            Continue / Try again (all rows)
          </button>
        )}
      </div>
      {rows.map((row) => (
        <div key={row.ref} className="row between" style={{ gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <code className="mono tiny">{row.ref.length > 60 ? row.ref.slice(0, 60) + '…' : row.ref}</code>
            <div className="tiny muted">
              {row.done} / {row.total || '?'} contents · {formatBytes(row.bytes)} uploaded · {row.skipped} already there
              {row.missing ? ` · ${row.missing} missing on this node` : ''}
            </div>
            {row.error && (
              <div className="tiny" style={{ color: 'var(--danger)' }}>
                {row.error}
              </div>
            )}
          </div>
          <span className={`badge ${row.status === 'failed' ? 'danger' : row.status === 'running' ? 'accent' : row.status === 'done' ? 'ok' : ''}`}>
            {row.status === 'running' && <Spinner />} {row.status}
          </span>
          {(row.status === 'done' || row.status === 'failed') && (
            <button className="small" onClick={() => resume(row)}>
              Continue / Try again
            </button>
          )}
        </div>
      ))}
      {toast && <div className="banner info small">{toast}</div>}
    </div>
  );
}