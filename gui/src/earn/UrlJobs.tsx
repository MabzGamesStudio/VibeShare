import { Download, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, streamUrl } from '../api';
import { useApp } from '../state';
import { contentUrl, loadHosts, loadUrlJobs, pushHostedContent, recordUrlJobs, saveUrlJobs, type HostConfig, type UrlJobEntry } from './hosting';

/**
 * The URL jobs card, right under the Credits card: the data hosting URLs this client has
 * connected, one button that finds the provider's jobs and uploads every one of them to
 * every URL below with that URL's access token, and how each upload went. The provider
 * then downloads the full data from the URLs — this client stores nothing. With no URL
 * configured it points at the Provider jobs tab.
 */
export function UrlJobsCard({ providerId }: { providerId: string }) {
  const { toast } = useApp();
  const [hosts] = useState<HostConfig[]>(() => loadHosts());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ cid: string; host: string; ok: boolean; message: string }[]>([]);

  /** Finds this provider's jobs, then pushes every one of them to every configured URL. */
  const run = async () => {
    setBusy(true);
    setResults([]);
    try {
      const found = await api<{ items: { cid: string; title?: string; source: string }[] }>(`/api/nodes/${providerId}/storage-jobs`);
      const list = (found.items ?? []).slice(0, 5);
      if (!list.length) {
        toast('This provider has no open jobs right now', 'info');
        return;
      }
      const rows: { cid: string; host: string; ok: boolean; message: string }[] = [];
      const uploaded: UrlJobEntry[] = [];
      for (const job of list) {
        // A provider's job is only accepted for content an algorithm search node knows.
        const { known } = await api<{ known: Record<string, boolean> }>('/api/lookup', { body: { ids: [job.cid] } });
        if (!known[job.cid]) {
          rows.push({ cid: job.cid, host: '—', ok: false, message: 'Not accepted: no algorithm search node knows this content id' });
          continue;
        }
        const response = await fetch(streamUrl(job.cid, true));
        if (!response.ok) throw new Error(`Could not download ${job.cid} from the provider`);
        const data = new Uint8Array(await response.arrayBuffer());
        const done: string[] = [];
        let url = '';
        for (const host of hosts) {
          const answer = await pushHostedContent(host, job.cid, data);
          rows.push({ cid: job.cid, host: host.label, ok: answer.ok, message: answer.message });
          if (answer.ok) {
            done.push(host.label);
            if (!url) url = contentUrl(host.baseUrl, job.cid);
          }
        }
        if (done.length) {
          uploaded.push({
            id: `j-${Math.random().toString(36).slice(2, 10)}`,
            cid: job.cid,
            title: job.title,
            source: job.source,
            hosts: done,
            url,
            at: new Date().toISOString(),
          });
        }
      }
      setResults(rows);
      if (uploaded.length) recordUrlJobs(uploaded);
      const good = rows.filter((row) => row.ok).length;
      toast(`Uploaded to ${good} of ${rows.length} URL${rows.length === 1 ? '' : 's'}`, good ? 'success' : 'error');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
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
            The data hosting URLs connected to this client, and one button that finds this provider's jobs and uploads every one of them to
            every URL below with its access token. The provider then gets the full retrieved data from those URLs — this client stores
            nothing.
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
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {hosts.map((host) => (
              <span key={host.id} className="badge" title={host.baseUrl}>
                {host.label} · <span className="mono tiny">{host.baseUrl}</span>
              </span>
            ))}
          </div>
          <div className="row">
            <button className="primary small" disabled={busy || !providerId} onClick={() => void run()}>
              <Download size={14} /> {busy ? 'Finding jobs and uploading…' : 'Find jobs and upload to every URL'}
            </button>
            <span className="hint">One press: find the jobs, push each one to every URL with its access token, report each URL.</span>
          </div>
          {results.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {results.map((row, index) => (
                <div key={index} className="row small" style={{ gap: 8 }}>
                  <span className={`badge ${row.ok ? 'ok' : 'danger'}`}>{row.ok ? 'uploaded' : 'failed'}</span>
                  <span className="mono tiny">{row.cid.slice(0, 20)}…</span>
                  <span className="tiny faint">→ {row.host}</span>
                  <span className="tiny">{row.message}</span>
                </div>
              ))}
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
  const { toast } = useApp();
  const [jobs, setJobs] = useState<UrlJobEntry[]>(() => loadUrlJobs());
  const [paged, setPaged] = useState(true);
  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = paged ? jobs.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE) : jobs.slice(0, shown);

  /** Giving a job up removes it here at once — it no longer shows in the list. */
  const giveUp = (job: UrlJobEntry) => {
    const next = jobs.filter((entry) => entry.id !== job.id);
    setJobs(next);
    saveUrlJobs(next);
    toast('Gave the job up — it no longer shows here', 'success');
  };

  return (
    <div className="card form-stack">
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