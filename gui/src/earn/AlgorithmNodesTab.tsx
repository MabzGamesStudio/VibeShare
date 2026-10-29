import { Sparkles, Tags, TrendingUp, Vote } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AlgorithmInfo } from '../../../src/shared/protocol';
import { api } from '../api';
import { Empty, StatusDot } from '../components/ui';
import { useApp } from '../state';
import { timeAgo, watchPath } from '../util';
import { PlatformEarningsTable } from './PlatformEarnings';

interface Contributions {
  nodes: {
    node: string;
    name: string;
    error?: string;
    suggestions: { id: string; contentId: string; kind: string; value: string; status: string; agreeing: number; createdAt: string }[];
    submissions: { id: string; contentId: string; status: string; request: { title: string }; createdAt: string; note?: string }[];
  }[];
}

/**
 * The algorithm nodes tab: pick one of your algorithm nodes to see your credits there and
 * every way it pays — votes, accepted suggestions, reports — and the platform numbers
 * *Report stats* takes on every platform.
 */
export function AlgorithmNodesTab() {
  const { algorithms } = useApp();
  const [nodeId, setNodeId] = useState('');
  const [data, setData] = useState<Contributions | null>(null);
  useEffect(() => {
    api<Contributions>('/api/contributions').then(setData).catch(() => undefined);
  }, []);
  const target = algorithms.find((node) => node.id === nodeId) ?? algorithms[0];
  const info = target?.info as AlgorithmInfo | undefined;
  const mine = data?.nodes.find((n) => n.node === target?.id);

  if (!algorithms.length) {
    return (
      <Empty icon={<Sparkles size={42} />} title="No algorithm nodes yet">
        <p className="small muted">Add an algorithm node first — credits are earned and kept on each node separately.</p>
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
          Algorithm node
          <select value={target?.id ?? ''} onChange={(e) => setNodeId(e.target.value)}>
            {algorithms.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card form-stack">
        <div className="row">
          <Sparkles size={22} />
          <div>
            <h2>Credits on {target?.name}</h2>
            <p className="small muted">
              Credits never move between nodes: what this node pays lands on your account here, and what it charges for feeds and
              searches is paid from the same balance.
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
          <span className="small muted">{target?.status.online ? 'answered your last request' : target?.status.error ?? 'idle'}</span>
        </div>
        {info?.rewards && (
          <table className="table">
            <thead>
              <tr>
                <th>Way to earn</th>
                <th>What it pays</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="small">
                  <Vote size={13} style={{ verticalAlign: -2 }} /> First vote on a piece of content (Like / Dislike)
                </td>
                <td className="small">
                  {info.rewards.vote} credits (max {info.rewards.voteDailyCap}/day)
                </td>
              </tr>
              <tr>
                <td className="small">
                  <Tags size={13} style={{ verticalAlign: -2 }} /> Suggestion the node accepts (tags, ratings, topics, corrections)
                </td>
                <td className="small">{info.rewards.acceptedSuggestion} credits</td>
              </tr>
              <tr>
                <td className="small">
                  <TrendingUp size={13} style={{ verticalAlign: -2 }} /> Reporting a content id or link it did not have
                </td>
                <td className="small">
                  {info.rewards.report} credits (max {info.rewards.reportDailyCap}/day)
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {info?.rewards.requireIdentity && <span className="hint">Only key-based accounts earn rewards here.</span>}
        {(info?.rewards.autoAcceptAgreement ?? 0) > 0 && (
          <span className="hint">A suggestion is accepted automatically once {info?.rewards.autoAcceptAgreement} accounts made it.</span>
        )}
      </div>


      <div className="card form-stack">
        <div className="row">
          <TrendingUp size={22} />
          <div>
            <h2>Credit earning methods per platform</h2>
            <p className="small muted">
              Open content on the platform it lives on and use <strong>Watch → Suggest → Report stats</strong>: the numbers the platform
              shows earn credits wherever the content came from. This node's operator sets one weight per number and a recency factor,
              so popular and recent posts pay more — and reporting the same post again when the numbers grew earns again.
            </p>
          </div>
        </div>
        <PlatformEarningsTable />
        <p className="small muted">
          Beyond stats: report content the node does not have yet (ids or links), suggest corrections it accepts (tags, topics, format,
          age rating, creator, publish time — each with a reason), and vote on content with no vote yet.
        </p>
      </div>

      <div className="card form-stack">
        <div className="row">
          <Tags size={22} />
          <div>
            <h2>Your contributions to this node</h2>
            <p className="small muted">Suggestions and submissions of yours this node has reviewed — or is still reviewing.</p>
          </div>
        </div>
        {mine?.error && <div className="small faint">{mine.error}</div>}
        {mine && (mine.suggestions.length > 0 || mine.submissions.length > 0) ? (
          <table className="table">
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
        ) : (
          <p className="small muted">
            Nothing yet. Use Like / Suggest under any content — this node rewards votes and accepted suggestions.
          </p>
        )}
      </div>
    </>
  );
}