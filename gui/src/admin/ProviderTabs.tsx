import { useCallback, useEffect, useState } from 'react';
import { CopyButton, Loading, Modal, StatusDot, Switch } from '../components/ui';
import { formatBytes, timeAgo } from '../util';
import { admin, adminBytes, message } from './api';
import { parseVvshNode, type VvshFile, type VvshNode } from '../../../src/shared/vvsh.js';
import { base64url } from '../../../src/shared/encoding.js';
import { assembleVvshWebm, normalizeVvshWebmChunk } from '../../../src/shared/vvsh-encode.js';
import { useToast } from './AdminApp';

interface ContentRow {
  cid: string;
  name: string;
  mime: string;
  size: number;
  title?: string;
  uploader: string;
  createdAt: string;
  downloads: number;
  bytesServed: number;
  creditsEarned: number;
  /** Platform links added from client suggestions (one cid can carry several). */
  sources?: string[];
  /** Content ids clients reported as duplicates of this one. */
  duplicates?: string[];
}

function Content() {
  const [rows, setRows] = useState<ContentRow[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [job, setJob] = useState<ContentRow | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [form, setForm] = useState({ replicas: '2', durationDays: '30', upfront: '5', perRetrieval: '1', perChallenge: '1', completion: '20' });
  const [importPath, setImportPath] = useState('');
  const [toast, show] = useToast();

  const load = useCallback(() => {
    admin<{ items: ContentRow[] }>(`/v1/admin/content?offset=${offset}&limit=100`)
      .then((r) => setRows(r.items))
      .catch((e) => show(message(e)));
  }, [offset, show]);
  useEffect(load, [load]);

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Add a file from this machine</h3>
        <p className="small muted">Path of a file on the computer running the node. Anyone can also upload through a VibeShare client (Publish).</p>
        <div className="row">
          <input type="text" value={importPath} onChange={(e) => setImportPath(e.target.value)} placeholder="/srv/media/video.mp4" style={{ flex: 1 }} />
          <button
            className="primary"
            disabled={!importPath.trim()}
            onClick={async () => {
              try {
                const result = await admin<{ cid: string }>('/v1/admin/content/import', { body: { path: importPath.trim() } });
                show(`Added ${result.cid}`);
                setImportPath('');
                load();
              } catch (e) {
                show(message(e));
              }
            }}
          >
            Import
          </button>
        </div>
      </div>
      {!rows ? (
        <Loading />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Content</th>
                <th>Size</th>
                <th>Downloads</th>
                <th>Credits</th>
                <th>Uploader</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.cid}>
                  <td style={{ cursor: 'pointer' }} title="Open details" onClick={() => setDetails(row.cid)}>
                    <strong>{row.title ?? row.name}</strong>
                    <div className="tiny faint">
                      {row.mime} · {timeAgo(row.createdAt)}
                    </div>
                    <div className="mono tiny faint">{row.cid.slice(0, 24)}…</div>
                    {(row.sources?.length ?? 0) + (row.duplicates?.length ?? 0) > 0 && (
                      <div className="tiny faint">
                        {row.sources?.length ? `${row.sources.length} suggested source${row.sources.length === 1 ? '' : 's'}` : ''}
                        {row.sources?.length && row.duplicates?.length ? ' · ' : ''}
                        {row.duplicates?.length ? `${row.duplicates.length} duplicate${row.duplicates.length === 1 ? '' : 's'}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="small">{formatBytes(row.size)}</td>
                  <td className="small">
                    {row.downloads}
                    <div className="tiny faint">{formatBytes(row.bytesServed)} served</div>
                  </td>
                  <td className="small">{row.creditsEarned}</td>
                  <td className="mono tiny">{row.uploader.slice(0, 14)}</td>
                  <td>
                    <div className="row">
                      <CopyButton text={row.cid} label="Id" />
                      <button className="small" onClick={() => setJob(row)}>
                        Storage job
                      </button>
                      <button
                        className="small"
                        onClick={async () => {
                          const value = window.prompt('Credits per MiB for this content (empty = node default)');
                          if (value === null) return;
                          await admin(`/v1/admin/content/${row.cid}/price`, { body: { perMiB: value === '' ? null : Number(value) } }).catch((e) =>
                            show(message(e))
                          );
                          show('Price updated');
                        }}
                      >
                        Price
                      </button>
                      <button
                        className="small danger"
                        onClick={async () => {
                          if (!window.confirm(`Delete ${row.title ?? row.name} and its chunks from every backend?`)) return;
                          await admin(`/v1/admin/content/${row.cid}`, { method: 'DELETE' }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
          Newer
        </button>
        <button disabled={(rows?.length ?? 0) < 100} onClick={() => setOffset(offset + 100)}>
          Older
        </button>
      </div>
      {job && (
        <Modal
          title="Pay clients to store this"
          onClose={() => setJob(null)}
          actions={
            <button
              className="primary"
              onClick={async () => {
                try {
                  await admin('/v1/admin/storage/jobs', {
                    body: {
                      cid: job.cid,
                      replicas: Number(form.replicas),
                      durationDays: Number(form.durationDays),
                      rewards: {
                        upfront: Number(form.upfront),
                        perRetrieval: Number(form.perRetrieval),
                        perChallenge: Number(form.perChallenge),
                        completion: Number(form.completion),
                      },
                    },
                  });
                  show('Storage job created');
                  setJob(null);
                } catch (e) {
                  show(message(e));
                }
              }}
            >
              Create job
            </button>
          }
        >
          <p className="small muted" style={{ marginBottom: 12 }}>
            Client nodes with the storage service on keep copies of {job.title ?? job.name} ({formatBytes(job.size)}) and earn these credits.
          </p>
          <div className="form-grid">
            {(
              [
                ['replicas', 'Copies'],
                ['durationDays', 'Days'],
                ['upfront', 'Upfront (after first proof)'],
                ['perRetrieval', 'Per retrieval'],
                ['perChallenge', 'Per passed challenge'],
                ['completion', 'At the end of the term'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="field">
                {label}
                <input type="number" min={0} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
              </label>
            ))}
          </div>
        </Modal>
      )}
      {details && <ContentDetails cid={details} onClose={() => setDetails(null)} />}
      <Suggestions />
    </div>
  );
}

interface ContentDetailsData {
  record: ContentRow & { chunks: number };
  manifest?: {
    name: string;
    mime: string;
    size: number;
    chunkSize: number;
    createdAt: string;
    meta?: Record<string, unknown>;
    sources?: string[];
    creator?: { id: string; name?: string; kind?: string };
    vvsh?: VvshFile;
  };
  chunks?: { id: string; size: number; backends: string[] }[];
  suggestions?: SuggestionRow[];
}

/** Everything the node knows about one content, shown when its row is clicked. */
function ContentDetails({ cid, onClose }: { cid: string; onClose: () => void }) {
  const [data, setData] = useState<ContentDetailsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showVvsh, setShowVvsh] = useState(false);
  const [toast, show] = useToast();
  useEffect(() => {
    admin<ContentDetailsData>(`/v1/admin/content/${encodeURIComponent(cid)}`).then(setData).catch((e) => setError(message(e)));
  }, [cid]);
  const meta = (data?.manifest?.meta ?? {}) as { title?: string; description?: string; tags?: string[]; topics?: string[]; format?: string; rating?: string; durationSeconds?: number };
  const sources = [...new Set([...(data?.manifest?.sources ?? []), ...(data?.record.sources ?? [])])];
  return (
    <Modal title="Content details" onClose={onClose} wide>
      {error ? (
        <div className="banner danger small">{error}</div>
      ) : !data ? (
        <Loading />
      ) : (
        <div className="form-stack">
          <div>
            <h3>{data.record.title ?? meta.title ?? data.record.name}</h3>
            <div className="mono tiny faint">{data.record.cid}</div>
          </div>
          <dl className="kv">
            <dt>File</dt>
            <dd>
              {data.record.name} · {data.record.mime} · {formatBytes(data.record.size)}
            </dd>
            <dt>Chunks</dt>
            <dd>
              {data.manifest?.vvsh ? (
                <>
                  {data.manifest.vvsh.meta.chunkCount} chunks × {data.manifest.vvsh.meta.bitrates.length} encodings, each stored as its own object under
                  the tree root — the .vvsh file is metadata and the root, so it lists no byte chunks.{' '}
                  <button className="small" onClick={() => setShowVvsh(true)}>
                    View .vvsh
                  </button>
                </>
              ) : (
                <>
                  {data.record.chunks} × {formatBytes(data.manifest?.chunkSize ?? 0)} on{' '}
                  {[...new Set((data.chunks ?? []).flatMap((chunk) => chunk.backends))].join(', ') || 'no backend'}
                </>
              )}
            </dd>
            <dt>Uploader</dt>
            <dd className="mono tiny">{data.record.uploader}</dd>
            <dt>Added</dt>
            <dd>{timeAgo(data.record.createdAt)}</dd>
            <dt>Downloads</dt>
            <dd>
              {data.record.downloads} ({formatBytes(data.record.bytesServed)} served, {data.record.creditsEarned} credits earned)
            </dd>
            {data.manifest?.creator && (
              <>
                <dt>Creator</dt>
                <dd>
                  {data.manifest.creator.name ?? data.manifest.creator.id} ({data.manifest.creator.kind ?? 'unknown'})
                </dd>
              </>
            )}
            {meta.format && (
              <>
                <dt>Metadata</dt>
                <dd>
                  {meta.format}
                  {meta.rating ? ` · ${meta.rating}` : ''}
                  {meta.durationSeconds ? ` · ${Math.round(meta.durationSeconds)}s` : ''}
                  {meta.topics?.length ? ` · ${meta.topics.join(', ')}` : ''}
                  {meta.tags?.length ? ` · ${meta.tags.map((tag) => `#${tag}`).join(' ')}` : ''}
                </dd>
              </>
            )}
            <dt>Sources</dt>
            <dd>{sources.length ? sources.join(' · ') : 'None'}</dd>
            <dt>Duplicates</dt>
            <dd>{data.record.duplicates?.length ? data.record.duplicates.join(' · ') : 'None reported'}</dd>
          </dl>
          {meta.description && <p className="small">{meta.description}</p>}
          {showVvsh && data.manifest?.vvsh && <VvshModal vvsh={data.manifest.vvsh} onClose={() => setShowVvsh(false)} />}
          <div className="row">
            <button
              className="small"
              onClick={async () => {
                try {
                  const result = await admin<{ fetched: number; missing: number }>('/v1/admin/peers/fetch', { body: { cid: data.record.cid } });
                  show(`Pulled ${result.fetched} missing chunk${result.fetched === 1 ? '' : 's'} from peers${result.missing ? ` (${result.missing} still missing)` : ''}`);
                } catch (e) {
                  show(message(e));
                }
              }}
            >
              Fetch missing chunks from peers
            </button>
            <button
              className="small"
              onClick={async () => {
                try {
                  const result = await admin<{ results: { peer: string; sent: number; error?: string }[] }>('/v1/admin/peers/push', {
                    body: { cid: data.record.cid },
                  });
                  show(result.results.map((r) => `${r.peer.slice(0, 24)}: ${r.sent} sent${r.error ? ` (${r.error})` : ''}`).join(' · ') || 'No peer sent to');
                } catch (e) {
                  show(message(e));
                }
              }}
            >
              Send content to peers
            </button>
            {toast && <span className="small">{toast}</span>}
          </div>
          {data.suggestions && data.suggestions.length > 0 && (
            <div>
              <h3>Client suggestions</h3>
              {data.suggestions.map((suggestion) => (
                <div key={suggestion.id} className="small" style={{ marginTop: 6 }}>
                  <span className="badge">{suggestion.status}</span>{' '}
                  <strong>{suggestion.kind}</strong>{' '}
                  {suggestion.sources?.map((source) => `${source.platform}: ${source.url}`).join(', ') ?? suggestion.duplicateOf ?? suggestion.note ?? ''}
                  <div className="tiny faint">{timeAgo(suggestion.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

interface SuggestionRow {
  id: string;
  contentId: string;
  title?: string;
  kind: 'source' | 'duplicate' | 'missing';
  sources?: { platform: string; url: string }[];
  duplicateOf?: string;
  note?: string;
  status: string;
  createdAt: string;
}

/** What clients suggest this node is missing: sources, duplicates, absent data. */
function Suggestions() {
  const [rows, setRows] = useState<SuggestionRow[] | null>(null);
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ suggestions: SuggestionRow[] }>('/v1/admin/suggestions')
      .then((r) => setRows(r.suggestions))
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  return (
    <div className="card form-stack">
      <h3>Client suggestions</h3>
      <p className="small muted">
        What clients say this node is missing: links to the content on other platforms (one content id can carry several sources), other
        content ids it duplicates (helps dedupe and compression), or content data that is not here at all. Accepting merges the sources and
        duplicate ids into the content.
      </p>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="small faint">Nothing pending.</p>
      ) : (
        <table className="table">
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="small">
                  <strong>
                    {row.kind}: {row.title ?? row.contentId.slice(0, 24)}
                  </strong>
                  <div className="mono tiny faint">{row.contentId.slice(0, 40)}</div>
                  <div className="small">
                    {row.sources?.map((source) => (
                      <div key={source.url}>
                        {source.platform}: {source.url}
                      </div>
                    ))}
                    {row.duplicateOf && <div>duplicate of {row.duplicateOf}</div>}
                    {row.note && <div className="muted">{row.note}</div>}
                  </div>
                </td>
                <td className="tiny faint">{timeAgo(row.createdAt)}</td>
                <td>
                  <div className="row">
                    <button
                      className="small primary"
                      onClick={async () => {
                        await admin(`/v1/admin/suggestions/${row.id}/accept`, { body: {} }).catch((e) => show(message(e)));
                        load();
                      }}
                    >
                      Accept
                    </button>
                    <button
                      className="small"
                      onClick={async () => {
                        await admin(`/v1/admin/suggestions/${row.id}/reject`, { body: {} }).catch((e) => show(message(e)));
                        load();
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {toast && <div className="banner info small">{toast}</div>}
    </div>
  );
}

interface Backend {
  id: string;
  type: string;
  writable: boolean;
  priority: number;
  status: { ok: boolean; detail: string };
}

interface JobRow {
  id: string;
  title?: string;
  bytes: number;
  replicas: number;
  holders: number;
  assignments: number;
  durationSeconds: number;
  rewards: { upfront: number; perRetrieval: number; perChallenge: number; completion: number };
  status: string;
  createdAt: string;
}

interface AssignmentRow {
  id: string;
  jobId: string;
  accountId: string;
  status: string;
  challenges: { passed: number; failed: number };
  retrievals: number;
  earned: number;
  expiresAt: string;
}

function Storage() {
  const [backends, setBackends] = useState<Backend[] | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ backends: Backend[] }>('/v1/admin/storage/backends').then((r) => setBackends(r.backends)).catch((e) => show(message(e)));
    admin<{ jobs: JobRow[] }>('/v1/admin/storage/jobs').then((r) => setJobs(r.jobs)).catch(() => undefined);
    admin<{ assignments: AssignmentRow[] }>('/v1/admin/storage/assignments').then((r) => setAssignments(r.assignments)).catch(() => undefined);
  }, [show]);
  useEffect(load, [load]);

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card">
        <h3>Storage backends</h3>
        <p className="small muted" style={{ marginBottom: 10 }}>
          Where chunks are kept, tried in priority order. Add S3-compatible buckets, WebDAV, IPFS, mirrors or other providers under Settings →
          storage.backends.
        </p>
        {!backends ? (
          <Loading />
        ) : (
          <table className="table">
            <tbody>
              {backends.map((backend) => (
                <tr key={backend.id}>
                  <td>
                    <StatusDot online={backend.status.ok} /> <strong>{backend.id}</strong>
                  </td>
                  <td className="small">{backend.type}</td>
                  <td className="small">priority {backend.priority}</td>
                  <td className="small">{backend.writable ? 'read/write' : 'read only'}</td>
                  <td className="small muted">{backend.status.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h3>Storage jobs</h3>
        {jobs.length === 0 ? (
          <p className="small muted">None. Create one from the Content tab, or enable automatic jobs in Settings.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Holders</th>
                <th>Rewards</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <strong>{job.title ?? job.id}</strong>
                    <div className="tiny faint">
                      {formatBytes(job.bytes)} · {Math.round(job.durationSeconds / 86400)} days
                    </div>
                  </td>
                  <td className="small">
                    {job.holders}/{job.replicas}
                  </td>
                  <td className="tiny">
                    {job.rewards.upfront} upfront · {job.rewards.perRetrieval}/retrieval · {job.rewards.perChallenge}/proof · {job.rewards.completion} at end
                  </td>
                  <td>
                    <span className={`badge ${job.status === 'open' ? 'ok' : ''}`}>{job.status}</span>
                  </td>
                  <td>
                    {job.status === 'open' && (
                      <button
                        className="small"
                        onClick={async () => {
                          await admin(`/v1/admin/storage/jobs/${job.id}/close`, { body: {} }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Close
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h3>Client assignments</h3>
        {assignments.length === 0 ? (
          <p className="small muted">No client stores data for this node yet.</p>
        ) : (
          <table className="table">
            <tbody>
              {assignments.slice(0, 100).map((a) => (
                <tr key={a.id}>
                  <td className="mono tiny">{a.accountId.slice(0, 20)}…</td>
                  <td>
                    <span className="badge">{a.status}</span>
                  </td>
                  <td className="small">
                    {a.challenges.passed} ✓ / {a.challenges.failed} ✗
                  </td>
                  <td className="small">{a.retrievals} retrievals</td>
                  <td className="small">{a.earned} credits</td>
                  <td className="tiny faint">until {new Date(a.expiresAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface PeerRow {
  ref: string;
  send: boolean;
  receive: boolean;
}

/** Automatic syncing of content bytes with peers: how often, and the share/receive rates. */
function SyncJob() {
  const [sync, setSync] = useState<{ enabled: boolean; intervalMs: number; sendRatePerMin: number; receiveRatePerMin: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [toast, show] = useToast();
  type Sync = { enabled: boolean; intervalMs: number; sendRatePerMin: number; receiveRatePerMin: number };
  const load = useCallback(() => {
    admin<{ sync: Sync }>('/v1/admin/peers')
      .then((r) => setSync(r.sync))
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  const save = async (next: Sync) => {
    setSync(next);
    try {
      await admin('/v1/admin/peers/sync/config', { method: 'POST', body: next });
    } catch (e) {
      show(message(e));
      load();
    }
  };

  if (!sync) return <Loading />;
  return (
    <div className="card form-stack">
      <h3>Automatic content sync</h3>
      <p className="small muted">
        Periodically sync content bytes with peers: share chunks they are missing and pull chunks this node is missing. Set how often it runs
        and the most chunks shared and received per minute.
      </p>
      <Switch checked={sync.enabled} onChange={(enabled) => void save({ ...sync, enabled })} label="Run automatically" />
      <div className="form-grid">
        <label className="field">
          How often (minutes)
          <input type="number" min={1} defaultValue={Math.round(sync.intervalMs / 60000)} onBlur={(e) => void save({ ...sync, intervalMs: Math.round(Number(e.target.value) * 60000) })} />
        </label>
        <label className="field">
          Share rate (chunks/min)
          <input type="number" min={0} defaultValue={sync.sendRatePerMin} onBlur={(e) => void save({ ...sync, sendRatePerMin: Number(e.target.value) })} />
        </label>
        <label className="field">
          Receive rate (chunks/min)
          <input type="number" min={0} defaultValue={sync.receiveRatePerMin} onBlur={(e) => void save({ ...sync, receiveRatePerMin: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row">
        <button
          disabled={running}
          onClick={async () => {
            setRunning(true);
            try {
              const r = await admin<{ sent: number; received: number }>('/v1/admin/peers/sync', { method: 'POST', body: {} });
              show(`Synced: shared ${r.sent}, received ${r.received}`);
            } catch (e) {
              show(message(e));
            }
            setRunning(false);
          }}
        >
          {running ? 'Syncing…' : 'Run sync now'}
        </button>
        <span className="hint">It also runs on its own when enabled.</span>
      </div>
      {toast && <div className="banner info small">{toast}</div>}
    </div>
  );
}

/** Other content providers this node exchanges content bytes (chunks) with. */
function Peering() {
  const [peers, setPeers] = useState<PeerRow[] | null>(null);
  const [acceptPush, setAcceptPush] = useState(true);
  const [ref, setRef] = useState('');
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ peers: PeerRow[]; acceptPush: boolean }>('/v1/admin/peers')
      .then((r) => {
        setPeers(r.peers);
        setAcceptPush(r.acceptPush);
      })
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  const save = async (next: PeerRow[], push = acceptPush) => {
    setPeers(next);
    setAcceptPush(push);
    try {
      await admin('/v1/admin/peers', { method: 'PUT', body: { peers: next, acceptPush: push } });
    } catch (e) {
      show(message(e));
      load();
    }
  };

  return (
    <div className="card form-stack">
      <h3>Peering with other providers</h3>
      <p className="small muted">
        Peer content providers exchange content bytes: every chunk is addressed by the hash of its bytes, so a peer can fetch what it is
        missing and send what the others lack. <strong>Send</strong> lets this node serve and push chunks to the peer; <strong>Receive</strong>{' '}
        lets it fetch missing chunks from the peer and accept the peer's pushes.
      </p>
      {!peers ? (
        <Loading />
      ) : (
        <>
          {peers.map((peer, index) => (
            <div key={peer.ref} className="row between small">
              <code className="tiny">{peer.ref.length > 60 ? peer.ref.slice(0, 60) + '…' : peer.ref}</code>
              <div className="row" style={{ gap: 10 }}>
                <label className="row small" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={peer.send}
                    onChange={(e) => void save(peers.map((p, i) => (i === index ? { ...p, send: e.target.checked } : p)))}
                  />
                  Send
                </label>
                <label className="row small" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={peer.receive}
                    onChange={(e) => void save(peers.map((p, i) => (i === index ? { ...p, receive: e.target.checked } : p)))}
                  />
                  Receive
                </label>
                <button className="small danger" onClick={() => void save(peers.filter((_, i) => i !== index))}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div className="row">
            <input
              type="text"
              className="mono"
              placeholder="vs:provider:vk1…@https://other.example.org"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              disabled={!ref.trim()}
              onClick={async () => {
                await save([...peers, { ref: ref.trim(), send: true, receive: true }]);
                setRef('');
              }}
            >
              Add peer
            </button>
          </div>
          <Switch checked={acceptPush} onChange={(push) => void save(peers, push)} label="Accept chunks peers push to this node" />
        </>
      )}
      {toast && <div className="banner info small">{toast}</div>}
    </div>
  );
}

export function ProviderTabs({ tab }: { tab: string }) {
  if (tab === 'content') return <Content />;
  if (tab === 'storage')
    return (
      <>
        <Storage />
        <Peering />
        <SyncJob />
      </>
    );
  return null;
}

interface VvshChunkRow {
  index: number;
  node: string;
  path: string[];
  renditions: { id: string; hash: string; size: number; frames: { i: number; p: number; b: number } }[];
}

/** One .vvsh stream in full: its metadata, every chunk, and the merkle tree over them. */
function VvshModal({ vvsh, onClose }: { vvsh: VvshFile; onClose: () => void }) {
  const meta = vvsh.meta;
  const [chunkPlay, setChunkPlay] = useState<{ url: string; label: string; start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Plays one chunk's own bytes as a video — that block and nothing else. */
  const playChunk = async (index: number, renditionId: string) => {
    try {
      setError(null);
      const leaf = cursorNode?.kind === 'chunk' ? cursorNode.renditions.find((entry) => entry.id === renditionId) : undefined;
      if (!leaf) return;
      const start = index * meta.chunkSeconds;
      const end = Math.min(meta.totalSeconds, start + meta.chunkSeconds);
      if (meta.codec === 'vvsh-webm/1') {
        // A segmented block stands alone: its init part and the block itself.
        const rendition = meta.bitrates.find((entry) => entry.id === renditionId);
        const init = rendition?.initHash
          ? await adminBytes(`/v1/vvsh/objects/${encodeURIComponent(rendition.initHash)}`)
          : new Uint8Array(0);
        const storedPayload = await adminBytes(`/v1/vvsh/objects/${encodeURIComponent(leaf.hash)}`);
        const payload = normalizeVvshWebmChunk(storedPayload, index, meta.chunkSeconds);
        // A preview is a new one-chunk file: timestamps restart at zero and its Duration
        // is this block's few seconds, not the full source video's timeline.
        const out = assembleVvshWebm(init, [payload], { resetTimestamps: true, durationSeconds: end - start });
        const url = URL.createObjectURL(new Blob([Uint8Array.from(out)], { type: 'video/webm' }));
        setChunkPlay((old) => {
          if (old && old.url.startsWith('blob:')) URL.revokeObjectURL(old.url);
          return { url, label: `chunk ${index} · ${renditionId} (${out.length} bytes)`, start: 0, end: Number.POSITIVE_INFINITY };
        });
        return;
      }
      // The simplest way to turn any block's bytes into playing video: stream exactly this
      // block's time span from this node's own range endpoint. The bytes that arrive are
      // this block's bytes — the browser decodes them like any video, in any browser.
      const rendition = meta.bitrates.find((entry) => entry.id === renditionId) ?? meta.bitrates[0];
      const spec = base64url(
        new TextEncoder().encode(JSON.stringify({ r: vvsh.root, c: meta.chunkCount, q: renditionId, d: rendition.decodedBytes ?? 0 }))
      );
      setChunkPlay((old) => {
        if (old && old.url.startsWith('blob:')) URL.revokeObjectURL(old.url);
        return { url: `/v1/vvsh/stream/${spec}`, label: `chunk ${index} · ${renditionId}`, start, end };
      });
    } catch (e) {
      setError(message(e));
    }
  };
  // Exploring the stored tree by hand: a cursor on one node, moving left/right/down.
  const [cursor, setCursor] = useState<string[]>([vvsh.root]);
  const cursorHash = cursor[cursor.length - 1];
  const [cursorNode, setCursorNode] = useState<NonNullable<ReturnType<typeof parseVvshNode>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    setChunkPlay((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return null;
    });
    setCursorNode(null);
    void adminBytes(`/v1/vvsh/objects/${encodeURIComponent(cursorHash)}`)
      .then((bytes) => {
        if (!cancelled) setCursorNode(parseVvshNode(bytes, cursorHash));
      })
      .catch((e) => {
        if (!cancelled) setError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cursorHash]);
  return (
    <Modal title={`Stream · ${meta.chunkCount} chunks · ${meta.bitrates.length} encodings`} onClose={onClose} wide>
      {error && <div className="banner danger small">{error}</div>}
      <dl className="kv">
        <dt>Version</dt>
        <dd>
          {meta.v} · {meta.codec}
          {meta.sourceMime ? ` · ${meta.sourceMime}` : ''}
        </dd>
        <dt>Chunks</dt>
        <dd>
          {meta.chunkCount} × {meta.chunkSeconds}s · {meta.totalSeconds}s total
          {meta.avgChunkBytes ? ` · ≈ ${(meta.avgChunkBytes / 1_048_576).toFixed(2)} MB per chunk (average)` : ''}
        </dd>
        <dt>Frames</dt>
        <dd>
          {meta.frames.gop} · {meta.frames.pattern}
        </dd>
        <dt>Previews</dt>
        <dd>
          {meta.previews
            ? `${meta.previews.images.length} × ${meta.previews.seconds.toFixed(2)}s` +
              (meta.previews.width ? ` · ${meta.previews.width}px` : '') +
              (meta.previews.quality ? ` · quality ${meta.previews.quality}` : '')
            : 'none'}
        </dd>
        <dt>Root</dt>
        <dd className="mono tiny">{vvsh.root}</dd>
      </dl>
      <details open>
        <summary>Explore the stored tree — one branch at a time</summary>
        <div className="row" style={{ alignItems: 'center', marginTop: 8 }}>
          {cursorNode?.kind === 'branch' ? (
            <>
              <button onClick={() => setCursor((path) => [...path, cursorNode.left])}>◀ left</button>
              <button onClick={() => setCursor((path) => [...path, cursorNode.right])}>right ▶</button>
            </>
          ) : null}
          {cursor.length > 1 ? <button onClick={() => setCursor((path) => path.slice(0, -1))}>↑ up</button> : null}
          <button onClick={() => setCursor([vvsh.root])}>reset to root</button>
        </div>
        <dl className="kv">
          <dt>Level</dt>
          <dd>
            {cursor.length - 1} of {meta.chunkCount > 1 ? Math.ceil(Math.log2(meta.chunkCount)) : 0}+ · at{' '}
            {cursorNode ? (cursorNode.kind === 'branch' ? 'a branch' : `chunk ${cursorNode.index}`) : 'loading…'}
          </dd>
          <dt>Hash</dt>
          <dd className="mono tiny">{cursorHash}</dd>
          {cursorNode?.kind === 'branch' && (
            <>
              <dt>Left child</dt>
              <dd className="mono tiny">{cursorNode.left}</dd>
              <dt>Right child</dt>
              <dd className="mono tiny">{cursorNode.right}</dd>
            </>
          )}
          {cursorNode?.kind === 'chunk' && (
            <>
              <dt>Leaves</dt>
              <dd>
                {cursorNode.renditions.map((leaf) => (
                  <div key={leaf.id} className="mono tiny">
                    {leaf.id} · {leaf.size} bytes · {leaf.frames.i} I / {leaf.frames.p} P / {leaf.frames.b} B · {leaf.hash}
                  </div>
                ))}
              </dd>
            </>
          )}
        </dl>
        {cursorNode?.kind === 'chunk' && (
          <div className="row">
            {cursorNode.renditions.map((leaf) => (
              <button key={leaf.id} onClick={() => void playChunk(cursorNode.index, leaf.id)}>
                ▶ play {leaf.id} (this block only)
              </button>
            ))}
          </div>
        )}
        {chunkPlay && (
          <div className="form-stack" style={{ marginTop: 8 }}>
            <div className="row between">
              <span className="small">
                Playing only {chunkPlay.label} — this block's own bytes, nothing before or after it
                {meta.codec === 'vvsh-frames/1' ? ' (a slice of the original file: it may not stand alone)' : ''}
              </span>
              <button
                className="small"
                onClick={() =>
                  setChunkPlay((old) => {
                    if (old) URL.revokeObjectURL(old.url);
                    return null;
                  })
                }
              >
                Close
              </button>
            </div>
            <video
              key={chunkPlay.url}
              src={chunkPlay.url}
              controls
              autoPlay
              playsInline
              style={{ width: '100%', borderRadius: 6 }}
              onLoadedMetadata={(e) => {
                if (chunkPlay.start > 0) e.currentTarget.currentTime = chunkPlay.start;
              }}
              onTimeUpdate={(e) => {
                if (e.currentTarget.currentTime >= chunkPlay.end) e.currentTarget.pause();
              }}
            />
          </div>
        )}
      </details>
    </Modal>
  );
}
