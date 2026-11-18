import { Download, Pencil, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, streamUrl } from '../api';
import { useApp } from '../state';
import { contentUrl, loadHosts, loadUrlJobs, pushHostedContent, recordUrlJobs, saveHosts, saveUrlJobs, type HostConfig, type UrlJobEntry } from './hosting';

/**
 * The URL jobs card, right under the Credits card: the data hosting URLs this client has
 * connected, one button that finds the provider's jobs and uploads every one of them to
 * every URL below with that URL's access token, and how each upload went. The provider
 * then downloads the full data from the URLs — this client stores nothing. With no URL
 * configured it points at the Provider jobs tab.
 */
type JobStage = 'queued' | 'downloading' | 'uploading' | 'done' | 'failed' | 'cancelled';

/** One job of a run: its own row, its own bar, its own cancel button. */
interface JobProgress {
  cid: string;
  title?: string;
  source: string;
  host?: string;
  stage: JobStage;
  /** 0–100; the download fills 0–60, the upload 60–100. */
  percent: number;
  bytes: number;
  total?: number;
  message?: string;
}

/** Reads a response body while reporting how many bytes arrived, so the bar moves. */
async function readWithProgress(response: Response, onBytes: (bytes: number) => void): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      bytes += value.length;
      onBytes(bytes);
    }
  }
  const data = new Uint8Array(bytes);
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  return data;
}

export function UrlJobsCard({ providerId }: { providerId: string }) {
  const { toast } = useApp();
  const [hosts, setHosts] = useState<HostConfig[]>(() => loadHosts());
  const [editing, setEditing] = useState<{ id: string; label: string; baseUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<JobProgress[]>([]);
  // Stopping: the run loop reads `stop` between jobs, and every in-flight download has
  // its own controller so one job can be cancelled without touching the others.
  const stop = useRef(false);
  const cancelled = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());

  /** Saving an edited URL updates that row in place. */
  const saveEdit = () => {
    if (!editing) return;
    const url = editing.baseUrl.trim();
    const next = hosts.map((host) =>
      host.id === editing.id ? { ...host, label: editing.label.trim() || host.label, baseUrl: url.endsWith('/') ? url : `${url}/` } : host
    );
    setHosts(next);
    saveHosts(next);
    setEditing(null);
    toast('Saved the URL', 'success');
  };

  /** Deleting a URL takes it off the list at once. */
  const removeHost = (id: string) => {
    const next = hosts.filter((host) => host.id !== id);
    setHosts(next);
    saveHosts(next);
    toast('Deleted the URL', 'success');
  };

  /** Updates one job's row. */
  const patch = (cid: string, next: Partial<JobProgress>) =>
    setProgress((rows) => rows.map((row) => (row.cid === cid ? { ...row, ...next } : row)));

  /** Cancels one job: its download aborts at once; an upload already in flight is not
   * re-tried on another URL. */
  const cancelJob = (cid: string) => {
    cancelled.current.add(cid);
    controllers.current.get(cid)?.abort();
    patch(cid, { stage: 'cancelled', message: 'Cancelled' });
  };

  /** Stops the whole run: no new job starts and the current download is aborted. */
  const stopAll = () => {
    stop.current = true;
    for (const controller of controllers.current.values()) controller.abort();
    setProgress((rows) =>
      rows.map((row) =>
        row.stage === 'queued' || row.stage === 'downloading' || row.stage === 'uploading'
          ? { ...row, stage: 'cancelled', message: row.stage === 'queued' ? 'Stopped' : row.message ?? 'Stopped' }
          : row
      )
    );
  };

  /**
   * Finds this provider's jobs and puts each one on one of the URLs below — one row per
   * job with its own progress bar and cancel button, and a stop-all that ends the run.
   */
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setProgress([]);
    stop.current = false;
    cancelled.current.clear();
    controllers.current.clear();
    try {
      const found = await api<{ items: { cid: string; title?: string; source: string }[] }>(`/api/nodes/${providerId}/storage-jobs`);
      const list = found.items ?? [];
      if (!list.length) {
        toast('This provider has no open jobs right now', 'info');
        return;
      }
      setProgress(list.map((job) => ({ cid: job.cid, title: job.title, source: job.source, stage: 'queued', percent: 0, bytes: 0 })));
      const uploaded: UrlJobEntry[] = [];
      let next = 0;
      for (const job of list) {
        if (stop.current || cancelled.current.has(job.cid)) {
          if (stop.current) patch(job.cid, { stage: 'cancelled', message: 'Stopped' });
          continue;
        }
        const controller = new AbortController();
        controllers.current.set(job.cid, controller);
        try {
          // A provider's job is only accepted for content an algorithm search node knows.
          const { known } = await api<{ known: Record<string, boolean> }>('/api/lookup', { body: { ids: [job.cid] } });
          if (!known[job.cid]) {
            patch(job.cid, { stage: 'failed', message: 'Not accepted: no algorithm search node knows this content id' });
            continue;
          }
          patch(job.cid, { stage: 'downloading', percent: 2 });
          const response = await fetch(streamUrl(job.cid, true), { signal: controller.signal });
          if (!response.ok) throw new Error(`Could not download ${job.cid} from the provider`);
          const total = Number(response.headers.get('content-length') ?? 0) || undefined;
          const data = await readWithProgress(response, (bytes) =>
            patch(job.cid, { bytes, total, percent: total ? Math.min(60, Math.round((bytes / total) * 60)) : 60 })
          );
          patch(job.cid, { stage: 'uploading', percent: 65 });
          let placed = false;
          let lastMessage = 'No URL took it';
          for (let tried = 0; tried < hosts.length && !placed; tried++) {
            if (stop.current || cancelled.current.has(job.cid)) break;
            const host = hosts[(next + tried) % hosts.length];
            const answer = await pushHostedContent(host, job.cid, data);
            lastMessage = answer.message;
            if (answer.ok) {
              placed = true;
              next = (next + tried + 1) % hosts.length;
              patch(job.cid, { stage: 'done', percent: 100, host: host.label, message: answer.message });
              uploaded.push({
                id: `j-${Math.random().toString(36).slice(2, 10)}`,
                cid: job.cid,
                title: job.title,
                source: job.source,
                hosts: [host.label],
                url: answer.url ?? contentUrl(host.baseUrl, job.cid),
                at: new Date().toISOString(),
              });
            } else {
              patch(job.cid, { message: answer.message });
            }
          }
          if (!placed && !stop.current && !cancelled.current.has(job.cid)) {
            patch(job.cid, { stage: 'failed', message: lastMessage });
          }
        } catch (error) {
          if (controller.signal.aborted || cancelled.current.has(job.cid)) {
            patch(job.cid, { stage: 'cancelled', message: 'Cancelled' });
          } else {
            patch(job.cid, { stage: 'failed', message: errorMessage(error) });
          }
        } finally {
          controllers.current.delete(job.cid);
        }
      }
      if (uploaded.length) recordUrlJobs(uploaded);
      const good = uploaded.length;
      if (stop.current) toast(`Stopped — ${good} of ${list.length} job${list.length === 1 ? '' : 's'} placed before stopping`, 'info');
      else toast(`${good} of ${list.length} job${list.length === 1 ? '' : 's'} placed on your URLs`, good ? 'success' : 'error');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      controllers.current.clear();
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack">
      <div className="row">
        <Upload size={22} />
        <div>
          <h2>URL jobs</h2>
          <p className="small muted">
            The data hosting URLs connected to this client, and one button that finds this provider's jobs and puts each one on one of the
            URLs below — a single copy each, the URLs taking turns, and the remaining ones tried when a push fails. The provider then gets
            the full retrieved data from those URLs — this client stores nothing.
          </p>
        </div>
      </div>
      {hosts.length === 0 ? (
        <p className="small muted">
          No data hosting URLs connected yet — set one up first in{' '}
          <Link className="link" to="/earn?tab=provider-jobs">
            Earn → Provider jobs
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="form-stack" style={{ gap: 6 }}>
            {hosts.map((host) =>
              editing?.id === host.id ? (
                <div key={host.id} className="row" style={{ gap: 6 }}>
                  <input
                    type="text"
                    value={editing.label}
                    placeholder="Name"
                    style={{ maxWidth: 150 }}
                    onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                  />
                  <input
                    type="text"
                    className="mono"
                    value={editing.baseUrl}
                    placeholder="https://…"
                    style={{ flex: 1 }}
                    onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                  />
                  <button className="small primary" onClick={saveEdit}>
                    Save
                  </button>
                  <button className="small" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div key={host.id} className="row between">
                  <span className="small" title={host.baseUrl}>
                    <strong>{host.label}</strong> · <span className="mono tiny">{host.baseUrl}</span>
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <button className="small" onClick={() => setEditing({ id: host.id, label: host.label, baseUrl: host.baseUrl })}>
                      <Pencil size={13} /> Edit
                    </button>
                    <button className="small danger" onClick={() => removeHost(host.id)}>
                      <Trash2 size={13} /> Delete
                    </button>
                  </span>
                </div>
              )
            )}
          </div>
          <div className="row" style={{ alignItems: 'center' }}>
            <button className="primary small" disabled={busy || !providerId || !hosts.length} onClick={() => void run()}>
              <Download size={14} /> {busy ? 'Finding jobs and uploading…' : 'Find jobs and upload'}
            </button>
            {/* Stops the run: no further job starts and the current download is aborted. */}
            <button className="small danger" disabled={!busy} onClick={stopAll}>
              <X size={14} /> Stop all storage jobs
            </button>
            <span className="hint">
              One press: find the jobs and put each one on one of your URLs — a single copy each, spread over the URLs in turn, with the
              others tried when one fails.
            </span>
          </div>
          {progress.length > 0 && (
            <div className="form-stack" style={{ gap: 8 }}>
              {progress.map((job) => {
                const live = job.stage === 'queued' || job.stage === 'downloading' || job.stage === 'uploading';
                const tone = job.stage === 'done' ? 'ok' : job.stage === 'failed' ? 'danger' : '';
                return (
                  <div key={job.cid} className="card form-stack" style={{ padding: 10, gap: 6 }}>
                    <div className="row between" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="row" style={{ gap: 6, minWidth: 0, alignItems: 'center' }}>
                        <span className={`badge ${tone}`}>{job.stage}</span>
                        <span className="mono tiny">{job.cid.slice(0, 20)}…</span>
                        {job.title ? <span className="tiny faint">{job.title}</span> : null}
                        {job.host ? <span className="tiny faint">→ {job.host}</span> : null}
                      </span>
                      <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <span className="tiny faint">{job.percent}%</span>
                        <button className="small" disabled={!live} onClick={() => cancelJob(job.cid)}>
                          <X size={13} /> Cancel
                        </button>
                      </span>
                    </div>
                    <div className="progress" aria-label={`${job.cid.slice(0, 12)} progress`}>
                      <div style={{ width: `${job.percent}%` }} />
                    </div>
                    {job.message ? <span className="tiny faint">{job.message}</span> : null}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const PAGE_SIZE = 5;

/**
 * "Store data for providers": the URL jobs this client holds. Each one was actively
 * created or selected in the Provider jobs tab (or uploaded with the URL jobs card) and
 * is hosted at the data hosting URLs — the provider gets the full retrieved data from
 * those URLs and nothing is kept on this machine. There are no local hosting jobs here.
 * Giving a job up takes it off the list at once. The job cards sit in an inner scroll
 * area, either paged or lazy-loaded.
 */
export function UrlJobsList() {
  const { toast, providers } = useApp();
  const [jobs, setJobs] = useState<UrlJobEntry[]>(() => loadUrlJobs());
  const [paged, setPaged] = useState(true);
  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(PAGE_SIZE);
  // What the provider has paid for each job so far, and what testing its URL answered.
  const [earned, setEarned] = useState<Record<string, number>>({});
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = paged ? jobs.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE) : jobs.slice(0, shown);

  // The credits each job has earned, from the provider's own records of its assignments.
  useEffect(() => {
    let live = true;
    void (async () => {
      const map: Record<string, number> = {};
      for (const node of providers) {
        try {
          const answer = await api<{ items: { cid: string; earned?: number }[] }>(`/api/nodes/${node.id}/storage-jobs`);
          for (const item of answer.items ?? []) map[item.cid] = (map[item.cid] ?? 0) + (item.earned ?? 0);
        } catch {
          // A node that will not answer simply shows no number for its jobs.
        }
      }
      if (live) setEarned(map);
    })();
    return () => {
      live = false;
    };
  }, [providers]);

  /** Tests that the URL listed serves the job's data with the right hash. */
  const testUrl = async (job: UrlJobEntry) => {
    setTesting(job.id);
    try {
      const answer = await api<{ ok: boolean; size: number; error?: string }>('/api/content-link', {
        method: 'POST',
        body: { url: job.url, cid: job.cid },
      });
      setTests((current) => ({
        ...current,
        [job.id]: answer.ok
          ? { ok: true, message: `✓ ${answer.size} bytes at that URL hash to this content id exactly.` }
          : { ok: false, message: `✗ ${answer.error ?? 'The data there does not hash to this content id'}` },
      }));
    } catch (error) {
      setTests((current) => ({ ...current, [job.id]: { ok: false, message: `✗ ${errorMessage(error)}` } }));
    } finally {
      setTesting(null);
    }
  };

  /** Giving a job up removes it here at once — it no longer shows in the list. */
  const giveUp = (job: UrlJobEntry) => {
    const next = jobs.filter((entry) => entry.id !== job.id);
    setJobs(next);
    saveUrlJobs(next);
    toast('Gave the job up — it no longer shows here', 'success');
  };

  return (
    <div className="card form-stack" id="store-data">
      <div className="row">
        <Download size={22} />
        <div>
          <h2>Store data for providers</h2>
          <p className="small muted">
            The URL jobs this client holds — hosted at your data hosting URLs, with nothing kept on this machine and no local hosting jobs.
            A job only appears here when you create or select it in Provider jobs (or upload it with the URL jobs card); giving one up takes
            it off this list at once.
          </p>
        </div>
      </div>
      {jobs.length === 0 ? (
        <p className="small muted">
          No URL jobs yet — fetch a job's content id and publish it in{' '}
          <Link className="link" to="/earn?tab=provider-jobs">
            Earn → Provider jobs
          </Link>
          , or find and upload jobs with the URL jobs card above.
        </p>
      ) : (
        <>
          <div className="row between small">
            <span className="muted">
              {jobs.length} job{jobs.length === 1 ? '' : 's'}
              {paged ? ` · page ${current + 1} of ${pages}` : ` · showing ${visible.length}`}
            </span>
            <div className="row" style={{ gap: 6 }}>
              <span className="hint">Show as</span>
              <select
                value={paged ? 'paged' : 'lazy'}
                onChange={(e) => {
                  setPaged(e.target.value === 'paged');
                  setPage(0);
                  setShown(PAGE_SIZE);
                }}
              >
                <option value="paged">Pagination</option>
                <option value="lazy">Lazy load</option>
              </select>
              {paged && (
                <>
                  <button className="small" disabled={current === 0} onClick={() => setPage(current - 1)}>
                    Previous
                  </button>
                  <button className="small" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                    Next
                  </button>
                </>
              )}
            </div>
          </div>
          <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map((job) => (
              <div key={job.id} className="card form-stack" style={{ padding: 12, margin: 0 }}>
                <div className="row between">
                  <div>
                    <strong>{job.title ?? `${job.cid.slice(0, 18)}…`}</strong>
                    <div className="mono tiny faint">{job.cid}</div>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="tiny faint">{new Date(job.at).toLocaleDateString()}</span>
                    {earned[job.cid] !== undefined && (
                      <span className="badge ok" title="Credits received from the provider for this job">
                        {earned[job.cid]} credits
                      </span>
                    )}
                    <button className="small" disabled={testing === job.id} title="Check that the URL serves the data with the right hash" onClick={() => void testUrl(job)}>
                      {testing === job.id ? 'Testing…' : 'Test the URL'}
                    </button>
                    <button className="small danger" title="Give the job up — it no longer shows here" onClick={() => giveUp(job)}>
                      <X size={13} /> Give up
                    </button>
                  </div>
                </div>
                <div className="tiny faint">
                  Hosted on {job.hosts.join(', ') || '—'} · from {job.source}
                </div>
                <div className="tiny">
                  URL to get the full retrieved data:{' '}
                  <a className="link mono" href={job.url} target="_blank" rel="noreferrer">
                    {job.url}
                  </a>
                </div>
                {tests[job.id] && <div className={`tiny ${tests[job.id].ok ? 'check-ok' : 'check-bad'}`}>{tests[job.id].message}</div>}
              </div>
            ))}
            {!paged && visible.length < jobs.length && (
              <button className="small" onClick={() => setShown(shown + PAGE_SIZE)}>
                Load more ({jobs.length - visible.length} left)
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}