import { useCallback, useEffect, useState } from 'react';
import { CopyButton, Loading, Modal, StatusDot } from '../components/ui';
import { formatBytes, timeAgo } from '../util';
import { admin, message } from './api';
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
}

function Content() {
  const [rows, setRows] = useState<ContentRow[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [job, setJob] = useState<ContentRow | null>(null);
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
                  <td>
                    <strong>{row.title ?? row.name}</strong>
                    <div className="tiny faint">
                      {row.mime} · {timeAgo(row.createdAt)}
                    </div>
                    <div className="mono tiny faint">{row.cid.slice(0, 24)}…</div>
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

export function ProviderTabs({ tab }: { tab: string }) {
  if (tab === 'content') return <Content />;
  if (tab === 'storage') return <Storage />;
  return null;
}
