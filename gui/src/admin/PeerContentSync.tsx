// Manual content sync: ship this node's full catalog — content entries with their
// metadata (listing decisions, tags, ratings, topics), topics, comments and the
// creators/groups data — to other algorithm nodes the operator names. The console
// drives the push batch by batch (POST /v1/admin/peers/push), shows per-node progress
// per category, and resumes an interrupted sync from its cursor: only what is still
// missing goes out again (re-sending anything is harmless anyway — the receiving node
// upserts, and keeps the comment chains it already has).
import { useEffect, useRef, useState } from 'react';
import { parseNodeRefs } from '../../../src/shared/noderef';
import { PEER_PUSH_CATEGORIES, type PeerPushCategory, type PeerPushResult } from '../../../src/shared/protocol';
import { admin, message } from './api';
import { useToast } from './AdminApp';

const STORAGE_KEY = 'vibeshare-peer-content-sync';

const CATEGORY_LABELS: Record<PeerPushCategory, string> = {
  topics: 'Topics',
  creators: 'Creators & groups',
  entries: 'Entries',
  comments: 'Comments',
};

const STATUS_LABELS: Record<NodeSync['status'], string> = {
  queued: 'Queued',
  running: 'Running…',
  done: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

interface CategoryProgress {
  sent: number;
  total: number;
}

interface NodeSync {
  ref: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
  error?: string;
  /** How far the sync got: the category it works through and the cursor within it. */
  category: PeerPushCategory | null;
  cursor: string | null;
  progress: Record<PeerPushCategory, CategoryProgress>;
  /** What the receiving node left out (already there, comment data it cannot verify…). */
  skipped: number;
}

function emptyProgress(): Record<PeerPushCategory, CategoryProgress> {
  return { topics: { sent: 0, total: 0 }, creators: { sent: 0, total: 0 }, entries: { sent: 0, total: 0 }, comments: { sent: 0, total: 0 } };
}

function freshNode(ref: string): NodeSync {
  return { ref, status: 'queued', category: null, cursor: null, progress: emptyProgress(), skipped: 0 };
}

/** What was saved last time: the text and every row, so Continue survives a reload. */
function loadState(): { text: string; nodes: NodeSync[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { text: '', nodes: [] };
    const parsed = JSON.parse(raw) as { text?: string; nodes?: NodeSync[] };
    const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).map((row) => ({
      ...freshNode(row.ref),
      ...row,
      progress: { ...emptyProgress(), ...(row.progress ?? {}) },
      // Anything mid-flight when the page went away is there to be continued.
      status: row.status === 'running' || row.status === 'queued' ? 'interrupted' : row.status,
    }));
    return { text: String(parsed.text ?? ''), nodes };
  } catch {
    return { text: '', nodes: [] };
  }
}

function saveState(text: string, nodes: NodeSync[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ text, nodes }));
  } catch {
    // storage unavailable: the progress lasts for this page only
  }
}

/** Bounds one request so a stalled push fails visibly (and can be retried) instead of hanging. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error))
    );
  });
}

/**
 * Manual content sync: the operator lists algorithm node references and one press
 * sends the full catalog to each of them, with per-node progress and a way to continue
 * a sync that stopped.
 */
export function PeerContentSync() {
  const [text, setText] = useState(() => loadState().text);
  const [nodes, setNodes] = useState<NodeSync[]>(() => loadState().nodes);
  const [toast, show] = useToast();
  const running = useRef(new Set<string>());
  // Every change is kept, so a reload still shows the rows and their Continue buttons.
  useEffect(() => saveState(text, nodes), [text, nodes]);
  const parsed = parseNodeRefs(text);
  const refs = [...new Set(parsed.refs.map((ref) => ref.url && (ref.id ? `vs:${ref.type}:${ref.id}@${ref.url}` : ref.url)))];

  const patch = (ref: string, change: (row: NodeSync) => NodeSync) =>
    setNodes((prev) => prev.map((row) => (row.ref === ref ? change(row) : row)));

  /** Drives one node's push: category by category, batch by batch, until it is done. */
  const drive = async (ref: string, from: { category: PeerPushCategory | null; cursor: string | null }) => {
    if (running.current.has(ref)) return;
    running.current.add(ref);
    patch(ref, (row) => ({ ...row, status: 'running', error: undefined }));
    let cursor = from.cursor;
    try {
      for (let index = Math.max(0, PEER_PUSH_CATEGORIES.indexOf(from.category ?? PEER_PUSH_CATEGORIES[0])); index < PEER_PUSH_CATEGORIES.length; index++) {
        const category = PEER_PUSH_CATEGORIES[index];
        for (;;) {
          let result: PeerPushResult;
          try {
            result = await withTimeout(
              admin<PeerPushResult>('/v1/admin/peers/push', { body: { ref, category, cursor: cursor ?? undefined } }),
              180_000
            );
          } catch (error) {
            patch(ref, (row) => ({ ...row, status: 'failed', error: message(error), category, cursor }));
            return;
          }
          if (result.error) {
            // The batch did not land: the row keeps its cursor and Try again re-sends it.
            patch(ref, (row) => ({ ...row, status: 'failed', error: result.error, category, cursor }));
            return;
          }
          const report = result.report;
          patch(ref, (row) => {
            const progress = emptyProgress();
            for (const cat of PEER_PUSH_CATEGORIES) {
              progress[cat] =
                cat === category
                  ? { sent: row.progress[cat].sent + result.sent, total: result.totals[cat] ?? row.progress[cat].total }
                  : { sent: row.progress[cat].sent, total: result.totals[cat] ?? row.progress[cat].total };
            }
            return {
              ...row,
              status: 'running',
              category,
              cursor: result.cursor,
              progress,
              skipped:
                row.skipped +
                (result.oversized ?? 0) +
                (report ? report.topics.skipped + report.creators.skipped + report.groups.skipped + report.entries.skipped + report.comments.skipped : 0),
            };
          });
          cursor = result.cursor;
          if (result.done) break;
          if (!cursor) {
            // The driver always reports a cursor while a category has more to send;
            // without one, driving on would only re-send the same batch forever.
            patch(ref, (row) => ({ ...row, status: 'failed', error: 'the push stopped without a cursor', category, cursor }));
            return;
          }
        }
        cursor = null;
      }
      patch(ref, (row) => ({ ...row, status: 'done', category: null, cursor: null }));
    } finally {
      running.current.delete(ref);
    }
  };

  /** Sends the full catalog to every listed node, from the top. */
  const send = () => {
    if (!refs.length) {
      show('List at least one node reference or URL');
      return;
    }
    const next = [...nodes];
    const driveThese: string[] = [];
    for (const ref of refs) {
      if (running.current.has(ref)) continue;
      const at = next.findIndex((row) => row.ref === ref);
      const row = freshNode(ref);
      if (at >= 0) next[at] = row;
      else next.push(row);
      driveThese.push(ref);
    }
    setNodes(next);
    for (const ref of driveThese) void drive(ref, { category: null, cursor: null });
    show(`Sending the full catalog to ${driveThese.length} node${driveThese.length === 1 ? '' : 's'}`);
  };

  /** Picks a stopped sync up where it left off (or re-sends the batch that failed). */
  const resume = (row: NodeSync) => {
    void drive(row.ref, { category: row.category, cursor: row.cursor });
  };

  return (
    <div className="card form-stack">
      <h3>Manual content sync</h3>
      <p className="small muted">
        Send this node's <strong>full catalog</strong> to other algorithm nodes: content entries with their metadata (listing decisions,
        tags, ratings, topics), topics, comments and the creators/groups data. One node reference per line, or separated by commas. A node
        only takes a catalog from a peer its operator configured it to serve.
      </p>
      <textarea
        className="mono"
        rows={3}
        placeholder={'vs:algorithm:vk1…@https://feed.example.org\nhttps://feed.example.org'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {parsed.invalid.length > 0 && (
        <div className="small" style={{ color: 'var(--danger)' }}>
          Not a node reference or URL: {parsed.invalid.join(', ')}
        </div>
      )}
      <div className="row">
        <button className="primary" disabled={!refs.length} onClick={send}>
          Send full catalog to these nodes
        </button>
        {toast && <span className="small">{toast}</span>}
      </div>
      {nodes.map((row) => (
        <div key={row.ref} className="card form-stack" style={{ padding: 10, gap: 6 }}>
          <div className="row between">
            <code className="tiny" style={{ wordBreak: 'break-all' }}>
              {row.ref}
            </code>
            <span className="badge">{STATUS_LABELS[row.status]}</span>
          </div>
          <div className="small muted">
            {PEER_PUSH_CATEGORIES.map((category) => `${CATEGORY_LABELS[category]} ${row.progress[category].sent}/${row.progress[category].total}`).join(
              ' · '
            )}
            {row.skipped > 0 ? ` · ${row.skipped} skipped` : ''}
          </div>
          {row.error && (
            <div className="small" style={{ color: 'var(--danger)' }}>
              {row.error}
            </div>
          )}
          {(row.status === 'failed' || row.status === 'interrupted') && (
            <div className="row">
              <button className="small" onClick={() => resume(row)}>
                {row.category ? 'Continue' : 'Try again'}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
