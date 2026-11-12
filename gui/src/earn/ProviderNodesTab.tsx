import { HardDrive } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ServiceStatus } from '../../../src/shared/clientapi';
import type { ProviderInfo } from '../../../src/shared/protocol';
import { api } from '../api';
import { Empty, StatusDot } from '../components/ui';
import { useApp } from '../state';
import { UrlJobsCard, UrlJobsList } from './UrlJobs';

/**
 * The provider nodes tab: pick one of your provider nodes to see your credits there and
 * the URL jobs you host for it — each one served from your data hosting URLs.
 */
export function ProviderNodesTab() {
  const { providers, state } = useApp();
  const [nodeId, setNodeId] = useState('');
  const [status, setStatus] = useState<ServiceStatus | null>(null);

  const load = () => api<ServiceStatus>('/api/services').then(setStatus).catch(() => undefined);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  if (!state) return null;
  const target = providers.find((node) => node.id === nodeId) ?? providers[0];
  const info = target?.info as ProviderInfo | undefined;
  const mine = status?.providers.find((p) => p.id === target?.id);

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

      {/* The balance of one node, as a card centered on the page. */}
      <div className="card form-stack" style={{ marginTop: 18 }}>
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
        <div className="row" style={{ gap: 16 }}>
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

      <UrlJobsCard providerId={target?.id ?? ''} />
      <UrlJobsList />

    </>
  );
}

