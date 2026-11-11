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
  const { algorithms, state } = useApp();
  const [nodeId, setNodeId] = useState('');
  const [data, setData] = useState<Contributions | null>(null);
  // Lazy loading or pagination over the rows below, with the page size the user picks.
  const [paged, setPaged] = useState(true);
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(25);
  // Listing the contributions is off by default: nothing is collected until the user
  // turns the log on in Settings → History.
  const logging = Boolean(state?.settings.logContributions);
  useEffect(() => {
    if (!logging) return;
    api<Contributions>('/api/contributions').then(setData).catch(() => undefined);
  }, [logging]);
  const target = algorithms.find((node) => node.id === nodeId) ?? algorithms[0];
  const info = target?.info as AlgorithmInfo | undefined;
  const mine = data?.nodes.find((n) => n.node === target?.id);
  // Submissions and suggestions as one list — the rows the card pages over.
  const rows: (
    | { type: 'submission'; id: string; contentId: string; status: string; title: string; note?: string; createdAt: string }
    | { type: 'suggestion'; id: string; contentId: string; status: string; what: string; value: string; agreeing: number; createdAt: string }
  )[] = [
    ...(mine?.submissions ?? []).map((entry) => ({
      type: 'submission' as const,
      id: entry.id,
      contentId: entry.contentId,
      status: entry.status,
      title: entry.request.title,
      note: entry.note,
      createdAt: entry.createdAt,
    })),
    ...(mine?.suggestions ?? []).map((entry) => ({
      type: 'suggestion' as const,
      id: entry.id,
      contentId: entry.contentId,
      status: entry.status,
      what: entry.kind,
      value: entry.value,
      agreeing: entry.agreeing,
      createdAt: entry.createdAt,
    })),
  ];
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages - 1);
  const visible = paged ? rows.slice(current * size, current * size + size) : rows.slice(0, shown);

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

      {/* The balance of one node, as a card centered on the page. */}
      <div className="card form-stack" style={{ margin: '18px auto 0', maxWidth: 620, textAlign: 'center' }}>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Sparkles size={22} />
          <div>
            <h2>Credits on {target?.name}</h2>
            <p className="small muted">
              Credits never move between nodes: what this node pays lands on your account here, and what it charges for feeds and
              searches is paid from the same balance.
            </p>
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'center', gap: 16 }}>
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
        {!logging ? (
          <p className="small muted">
            Nothing is logged by default. Turn on “Keep a log of my contributions to algorithm nodes” in{' '}
            <Link className="link" to="/settings#history">
              Settings → History
            </Link>{' '}
            and this card lists every suggestion and submission of yours.
          </p>
        ) : (
          <>
            {mine?.error && <div className="small faint">{mine.error}</div>}
            {rows.length > 0 ? (
              <>
                <div className="row between small">
                  <span className="muted">
                    {rows.length} item{rows.length === 1 ? '' : 's'}
                    {paged ? ` · page ${current + 1} of ${pages}` : ` · showing ${visible.length}`}
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="hint">Items per page</span>
                    <select
                      value={size}
                      onChange={(e) => {
                        setSize(Number(e.target.value));
                        setPage(0);
                        setShown(Number(e.target.value));
                      }}
                    >
                      {[10, 25, 50, 100].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <span className="hint">Show as</span>
                    <select
                      value={paged ? 'paged' : 'lazy'}
                      onChange={(e) => {
                        setPaged(e.target.value === 'paged');
                        setPage(0);
                        setShown(size);
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
                <table className="table">
                  <tbody>
                    {visible.map((row) =>
                      row.type === 'submission' ? (
                        <tr key={row.id}>
                          <td className="small">
                            Submitted{' '}
                            <Link className="link" to={watchPath(row.contentId)}>
                              {row.title}
                            </Link>
                            {row.note && <div className="tiny faint">{row.note}</div>}
                          </td>
                          <td>
                            <span className={`badge ${row.status === 'accepted' ? 'ok' : row.status === 'rejected' ? 'danger' : ''}`}>{row.status}</span>
                          </td>
                          <td className="tiny faint">{timeAgo(row.createdAt)}</td>
                        </tr>
                      ) : (
                        <tr key={row.id}>
                          <td className="small">
                            {row.what} “{row.value}” on{' '}
                            <Link className="link" to={watchPath(row.contentId)}>
                              {row.contentId.slice(0, 18)}…
                            </Link>
                            <div className="tiny faint">{row.agreeing} agreeing</div>
                          </td>
                          <td>
                            <span className={`badge ${row.status === 'accepted' ? 'ok' : row.status === 'rejected' ? 'danger' : ''}`}>{row.status}</span>
                          </td>
                          <td className="tiny faint">{timeAgo(row.createdAt)}</td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
                {!paged && visible.length < rows.length && (
                  <button className="small" onClick={() => setShown(shown + size)}>
                    Load more ({rows.length - visible.length} left)
                  </button>
                )}
              </>
            ) : (
              <p className="small muted">
                Nothing yet. Use Like / Suggest under any content — this node rewards votes and accepted suggestions.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}