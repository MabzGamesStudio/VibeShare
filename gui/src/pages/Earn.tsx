import { HardDrive, RefreshCw, Tags } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ServiceStatus } from '../../../src/shared/clientapi';
import type { AlgorithmInfo, ProviderInfo } from '../../../src/shared/protocol';
import { api, IS_STATIC } from '../api';
import { Chips, Loading, Switch, toggle } from '../components/ui';
import { useApp } from '../state';
import { formatBytes, timeAgo, watchPath } from '../util';

interface Contributions {
  nodes: {
    node: string;
    name: string;
    error?: string;
    suggestions: { id: string; contentId: string; kind: string; value: string; status: string; agreeing: number; createdAt: string }[];
    submissions: { id: string; contentId: string; status: string; request: { title: string }; createdAt: string; note?: string }[];
  }[];
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
        the web client: install the desktop app (or run <code>vibeshare client</code>) and restore your identity backup from Settings there to
        earn with the same accounts.
      </p>
    </div>
  );
}

function StorageService() {
  const { state, providers, updateSettings } = useApp();
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
  const capable = providers.filter((n) => (n.info as ProviderInfo | undefined)?.services?.storage?.enabled);
  const used = status?.usedBytes ?? 0;
  const quota = settings.quotaGiB * 1024 ** 3;

  return (
    <div className="card form-stack">
      <div className="row between">
        <div className="row">
          <HardDrive size={22} />
          <div>
            <h2>Store data for providers</h2>
            <p className="small muted">
              Providers pay credits for keeping copies of their content on your disk: when they fetch a chunk from you, when you prove you still
              have it, and at the end of the term.
            </p>
          </div>
        </div>
        <Switch checked={settings.enabled} onChange={(enabled) => void updateSettings({ storageService: { ...settings, enabled } })} />
      </div>
      <div className="form-grid">
        <label className="field">
          Disk space to offer (GiB)
          <input
            type="number"
            min={0}
            step={1}
            value={settings.quotaGiB}
            onChange={(e) => void updateSettings({ storageService: { ...settings, quotaGiB: Number(e.target.value) } })}
          />
        </label>
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
      </div>
      <div>
        <div className="row between small">
          <span>
            {formatBytes(used)} of {formatBytes(quota)} used
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
          <div style={{ width: `${quota ? Math.min(100, (used / quota) * 100) : 0}%` }} />
        </div>
      </div>
      {!status ? (
        <Loading />
      ) : (
        status.providers.map((provider) => (
          <div key={provider.id}>
            <div className="row between">
              <strong>{provider.name}</strong>
              <span className="small muted">
                {provider.online ? 'connected' : provider.error ?? 'idle'} · earned {provider.earned} credits
              </span>
            </div>
            {provider.assignments.length > 0 && (
              <table className="table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Assignment</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th>Challenges</th>
                    <th>Retrievals</th>
                    <th>Earned</th>
                  </tr>
                </thead>
                <tbody>
                  {provider.assignments.slice(0, 20).map((a) => (
                    <tr key={a.id}>
                      <td className="mono tiny">{a.id}</td>
                      <td className="small">{formatBytes(a.bytes)}</td>
                      <td>
                        <span className={`badge ${a.status === 'active' || a.status === 'completed' ? 'ok' : a.status === 'failed' ? 'danger' : ''}`}>
                          {a.status}
                        </span>
                      </td>
                      <td className="small">
                        {a.challenges.passed} ✓ / {a.challenges.failed} ✗
                      </td>
                      <td className="small">{a.retrievals}</td>
                      <td className="small">{a.earned}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))
      )}
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
  );
}

function ContributionsCard() {
  const { algorithms } = useApp();
  const [data, setData] = useState<Contributions | null>(null);
  useEffect(() => {
    api<Contributions>('/api/contributions').then(setData).catch(() => undefined);
  }, []);
  return (
    <div className="card form-stack">
      <div className="row">
        <Tags size={22} />
        <div>
          <h2>Help algorithm nodes</h2>
          <p className="small muted">
            Algorithm nodes reward votes and accepted suggestions (tags, ratings, topics, with a reason and the moment that shows it). Use the
            Like / Suggest buttons under any content.
          </p>
        </div>
      </div>
      {algorithms.map((node) => {
        const info = node.info as AlgorithmInfo | undefined;
        const mine = data?.nodes.find((n) => n.node === node.id);
        return (
          <div key={node.id}>
            <div className="row between">
              <strong>{node.name}</strong>
              {info && (
                <span className="small muted">
                  {info.rewards.vote} per vote (max {info.rewards.voteDailyCap}/day) · {info.rewards.acceptedSuggestion} per accepted suggestion
                  {info.rewards.requireIdentity ? ' · key accounts only' : ''}
                </span>
              )}
            </div>
            {mine?.error && <div className="small faint">{mine.error}</div>}
            {mine && (mine.suggestions.length > 0 || mine.submissions.length > 0) && (
              <table className="table" style={{ marginTop: 8 }}>
                <tbody>
                  {mine.submissions.map((s) => (
                    <tr key={s.id}>
                      <td className="small">
                        Submitted <Link className="link" to={watchPath(s.contentId)}>{s.request.title}</Link>
                        {s.note && <div className="tiny faint">{s.note}</div>}
                      </td>
                      <td>
                        <span className={`badge ${s.status === 'accepted' ? 'ok' : s.status === 'rejected' ? 'danger' : ''}`}>{s.status}</span>
                      </td>
                      <td className="tiny faint">{timeAgo(s.createdAt)}</td>
                    </tr>
                  ))}
                  {mine.suggestions.map((s) => (
                    <tr key={s.id}>
                      <td className="small">
                        {s.kind} “{s.value}” on <Link className="link" to={watchPath(s.contentId)}>{s.contentId.slice(0, 18)}…</Link>
                        <div className="tiny faint">{s.agreeing} agreeing</div>
                      </td>
                      <td>
                        <span className={`badge ${s.status === 'accepted' ? 'ok' : s.status === 'rejected' ? 'danger' : ''}`}>{s.status}</span>
                      </td>
                      <td className="tiny faint">{timeAgo(s.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function EarnPage() {
  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>Earn credits</h1>
          <p>Nodes pay credits for services. Earned credits land on your account on that node.</p>
        </div>
      </div>
      {IS_STATIC ? <StorageUnavailable /> : <StorageService />}
      <div style={{ height: 16 }} />
      <ContributionsCard />
    </div>
  );
}
