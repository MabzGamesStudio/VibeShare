import { HardDrive, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ServiceStatus, ServiceVerifyReport } from '../../../src/shared/clientapi';
import type { ProviderInfo, StorageAssignment } from '../../../src/shared/protocol';
import { api, IS_STATIC } from '../api';
import { Chips, Empty, Loading, StatusDot, Switch, toggle } from '../components/ui';
import { useApp } from '../state';
import { formatBytes, timeAgo } from '../util';

const JOB_PAGE_SIZE = 5;

/**
 * The jobs this client stores for one provider, as paginated cards: what each job
 * holds, the URL backups offered for it (or the local data when there are none), and
 * a button that tests the local copy against the job's hashes.
 */
function JobList({ providerId, assignments }: { providerId: string; assignments: StorageAssignment[] }) {
  const [page, setPage] = useState(0);
  const [reports, setReports] = useState<Record<string, ServiceVerifyReport | 'busy'>>({});
  const pages = Math.max(1, Math.ceil(assignments.length / JOB_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return (
    <div className="form-stack">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Stored jobs</h3>
        <div className="row" style={{ gap: 6 }}>
          <button className="small" disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous
          </button>
          <span className="small muted">
            {current + 1} / {pages} · {assignments.length} job{assignments.length === 1 ? '' : 's'}
          </span>
          <button className="small" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            Next
          </button>
        </div>
      </div>
      {assignments.slice(current * JOB_PAGE_SIZE, current * JOB_PAGE_SIZE + JOB_PAGE_SIZE).map((a) => {
        const report = reports[a.id];
        return (
          <div key={a.id} className="card form-stack">
            <div className="row between">
              <div>
                <strong>{a.title ?? a.jobId.slice(0, 14) + '…'}</strong>
                {a.cid ? <div className="mono tiny faint">{a.cid}</div> : null}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className={`badge ${a.status === 'active' || a.status === 'completed' ? 'ok' : a.status === 'failed' ? 'danger' : ''}`}>
                  {a.status}
                </span>
                <button
                  className="small"
                  disabled={report === 'busy'}
                  onClick={async () => {
                    setReports((m) => ({ ...m, [a.id]: 'busy' }));
                    try {
                      const answer = await api<{ reports: ServiceVerifyReport[] }>('/api/services/verify', {
                        method: 'POST',
                        body: { providerId, assignmentId: a.id },
                      });
                      setReports((m) => ({ ...m, [a.id]: answer.reports[0] }));
                    } catch {
                      setReports((m) => {
                        const { [a.id]: _gone, ...rest } = m;
                        return rest;
                      });
                    }
                  }}
                >
                  {report === 'busy' ? 'Testing…' : 'Test my copy'}
                </button>
              </div>
            </div>
            <div className="small muted">
              {formatBytes(a.bytes)} · {a.challenges.passed} ✓ / {a.challenges.failed} ✗ challenges · {a.retrievals} retrievals · {a.earned}{' '}
              credits
            </div>
            {a.links && a.links.length > 0 ? (
              <div>
                <div className="tiny faint">URL backups offered for this job</div>
                {a.links.map((link) => (
                  <div key={link.id} className="tiny mono">
                    <span className={`badge ${link.status === 'accepted' ? 'ok' : link.status === 'rejected' ? 'danger' : ''}`}>{link.status}</span>{' '}
                    {link.baseUrl ? `${link.baseUrl} (base URL)` : link.url}
                  </div>
                ))}
              </div>
            ) : (
              <div className="tiny faint">No URLs offered for this job — the data lives on this machine only.</div>
            )}
            <div className="tiny">
              Local storage:{' '}
              {a.local
                ? `${a.local.files}/${a.local.chunks} chunks · ${formatBytes(a.local.bytes)}${a.local.complete ? ' · complete' : ' · incomplete'}`
                : '…'}
            </div>
            {report && report !== 'busy' ? (
              <div className={`tiny ${report.complete ? '' : 'danger'}`}>
                {report.complete
                  ? `✓ tested: all ${report.chunks} chunk${report.chunks === 1 ? '' : 's'} match the job's hashes (${formatBytes(report.bytes)})`
                  : `✗ tested: ${report.ok} of ${report.chunks} chunks match — ${report.chunks - report.ok} missing or corrupt`}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The web client cannot keep data for providers: it only runs while a page is open. */
function StorageUnavailable() {
  return (
    <div className="card form-stack">
      <div className="row">
        <HardDrive size={22} />
        <h2>Store data for providers</h2>
      </div>
      <p className="small muted">
        Providers pay credits for keeping copies of their content on your disk. That needs a client that keeps running, so it is not part of
        the web client: install the desktop app (or run <code>vibeshare client</code>) and restore your identity backup from Settings there
        to earn with the same accounts.
      </p>
    </div>
  );
}

/**
 * The provider nodes tab: pick one of your provider nodes to see your credits there, the
 * disk space you offer it (and the total across all your nodes), and to look for jobs.
 */
export function ProviderNodesTab() {
  const { providers, state, updateSettings } = useApp();
  const [nodeId, setNodeId] = useState('');
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const load = () => api<ServiceStatus>('/api/services').then(setStatus).catch(() => undefined);
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  if (!state) return null;
  const settings = state.settings.storageService;
  const target = providers.find((node) => node.id === nodeId) ?? providers[0];
  const info = target?.info as ProviderInfo | undefined;
  const mine = status?.providers.find((p) => p.id === target?.id);
  const capable = providers.filter((n) => (n.info as ProviderInfo | undefined)?.services?.storage?.enabled);

  if (!providers.length) {
    return (
      <Empty icon={<HardDrive size={42} />} title="No provider nodes yet">
        <p className="small muted">Add a provider node first — credits are earned and kept on each node separately.</p>
        <Link className="link" to="/nodes">
          Add a node
        </Link>
      </Empty>
    );
  }

  return (
    <>
      <div className="form-grid">
        <label className="field">
          Provider node
          <select value={target?.id ?? ''} onChange={(e) => setNodeId(e.target.value)}>
            {providers.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card form-stack">
        <div className="row">
          <HardDrive size={22} />
          <div>
            <h2>Credits on {target?.name}</h2>
            <p className="small muted">
              Downloads, storage jobs and suggested links on this node all pay to your account here. What you earn storing data for
              providers shows below.
            </p>
          </div>
        </div>
        <div className="row between">
          <div className="row">
            <StatusDot online={target?.status.online} enabled={target?.enabled} />
            <strong style={{ fontSize: 22 }}>{target?.balance ?? '–'}</strong>
            <span className="muted">credits</span>
            {target?.accountId && (
              <span className="mono tiny faint" title={target.accountId}>
                {target.accountId.slice(0, 14)}…
              </span>
            )}
          </div>
          <span className="small muted">
            {mine ? `earned ${mine.earned} credits storing data` : target?.status.online ? 'answered your last request' : target?.status.error ?? 'idle'}
          </span>
        </div>
        {info?.rewards && (
          <p className="small muted">
            This node pays {info.rewards.report} credits for a content id it did not have (max {info.rewards.reportDailyCap}/day) and{' '}
            {info.rewards.suggestion} for a suggestion it accepts (max {info.rewards.suggestionDailyCap}/day).
          </p>
        )}
      </div>

      {IS_STATIC ? (
        <StorageUnavailable />
      ) : (
        <div className="card form-stack">
          <div className="row between">
            <div className="row">
              <HardDrive size={22} />
              <div>
                <h2>Store data for providers</h2>
                <p className="small muted">
                  Providers pay credits for keeping copies of their content on your disk: when they fetch a chunk from you, when you prove
                  you still have it, and at the end of the term. Every node gets its own share of disk.
                </p>
              </div>
            </div>
            <Switch checked={settings.enabled} onChange={(enabled) => void updateSettings({ storageService: { ...settings, enabled } })} />
          </div>

          <div className="form-grid">
            <label className="field">
              Disk space to offer on {target?.name} (GiB)
              <input
                type="number"
                min={0}
                step={1}
                value={settings.perProvider[target?.id ?? ''] ?? settings.quotaGiB}
                onChange={(e) => {
                  if (!target) return;
                  void updateSettings({
                    storageService: {
                      ...settings,
                      perProvider: { ...settings.perProvider, [target.id]: Math.max(0, Number(e.target.value) || 0) },
                    },
                  });
                }}
              />
              <span className="hint">Nodes without their own number use the default below.</span>
            </label>
            <label className="field">
              Default disk per node (GiB)
              <input
                type="number"
                min={0}
                step={1}
                value={settings.quotaGiB}
                onChange={(e) => void updateSettings({ storageService: { ...settings, quotaGiB: Number(e.target.value) } })}
              />
            </label>
          </div>

          <div>
            <div className="row between small">
              <span>
                {mine ? `${formatBytes(mine.usedBytes)} of ${formatBytes(mine.quotaBytes)} used on this node` : 'This provider has no storage jobs for you right now.'}
              </span>
              <button
                className="small"
                disabled={syncing || !settings.enabled}
                onClick={async () => {
                  setSyncing(true);
                  setStatus(await api<ServiceStatus>('/api/services/sync', { method: 'POST' }).catch(() => status));
                  setSyncing(false);
                }}
              >
                <RefreshCw size={13} /> Look for jobs now
              </button>
            </div>
            <div className="progress" style={{ marginTop: 6 }}>
              <div style={{ width: `${mine?.quotaBytes ? Math.min(100, (mine.usedBytes / mine.quotaBytes) * 100) : 0}%` }} />
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>
              {capable.length} provider node{capable.length === 1 ? '' : 's'} ·{' '}
              {formatBytes(status?.quotaBytes ?? 0)} offered in total across all your nodes · {formatBytes(status?.usedBytes ?? 0)} on disk
            </p>
          </div>

          <div className="field">
            <span>Providers to serve</span>
            {capable.length === 0 ? (
              <span className="hint">None of your providers runs a storage service.</span>
            ) : (
              <Chips
                options={capable.map((n) => n.id)}
                labels={Object.fromEntries(capable.map((n) => [n.id, n.name]))}
                selected={settings.providers.length ? settings.providers : capable.map((n) => n.id)}
                onToggle={(id) => {
                  const current = settings.providers.length ? settings.providers : capable.map((n) => n.id);
                  void updateSettings({ storageService: { ...settings, providers: toggle(current, id) } });
                }}
              />
            )}
          </div>

          {!status ? (
            <Loading />
          ) : mine && mine.assignments.length > 0 ? (
            <JobList providerId={mine.id} assignments={mine.assignments} />
          ) : null}

          {status && status.log.length > 0 && (
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                Activity
              </summary>
              <div style={{ marginTop: 8 }}>
                {status.log.slice(0, 30).map((entry, i) => (
                  <div key={i} className="small">
                    <span className="faint tiny">{timeAgo(entry.at)}</span> {entry.message}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </>
  );
}

