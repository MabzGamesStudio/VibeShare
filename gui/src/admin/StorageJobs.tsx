// Storage Jobs: every storage job this provider node opens — what it stores, which tier
// wants the copies, what it pays and how many of the wanted copies clients hold. Clicking
// a row opens the job in full, with the content's own "Storage jobs" tab beside it (the
// very component the content details modal shows for the same tab).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CopyButton, Loading, Modal } from '../components/ui';
import { formatBytes, timeAgo } from '../util';
import { admin, message } from './api';
import { useToast } from './AdminApp';
import { StorageJobsTab, type ContentDetailsData } from './ProviderTabs';

/** One storage job as /v1/admin/storage/jobs lists it: the job plus its assignment counts. */
interface StorageJobRow {
  id: string;
  cid?: string;
  title?: string;
  chunkIds: string[];
  bytes: number;
  replicas: number;
  durationSeconds: number;
  rewards: { upfront: number; perRetrieval: number; perChallenge: number; completion: number };
  requireIdentity: boolean;
  createdAt: string;
  openUntil?: string;
  status: 'open' | 'closed' | 'failed';
  managed?: boolean;
  challengeIntervalSeconds?: number;
  retrievalIntervalSeconds?: number;
  maxLatencyMs?: number;
  failedRequestsBeforeFailure?: number;
  lastEndpointTestAt?: number;
  /** Holder assignments currently active (status 'active'). */
  holders: number;
  /** Every holder assignment ever made under the job. */
  assignments: number;
}

/** The tier definitions of the node (/v1/admin/tiers config). */
interface TierPlan {
  id: string;
  label: string;
  media: Record<string, number>;
  externalUrls: number;
}

/** One content's tier assignment (the same endpoint's assignments). */
interface TierAssignmentRow {
  cid: string;
  tier: string;
  assignedAt: string;
  expiresAt?: string;
}

/** One holder assignment (/v1/admin/storage/assignments). It carries only the job id — */
/** the content it belongs to is reached through the job. */
interface AssignmentRow {
  id: string;
  jobId: string;
  accountId: string;
  status: string;
  acceptedAt: string;
  expiresAt: string;
  challenges: { passed: number; failed: number };
  retrievals: number;
  earned: number;
}

/** One row of the table, cross-referenced with the tiers and the holder assignments. */
interface JobView {
  job: StorageJobRow;
  tier?: { id: string; label: string };
  /** Holder assignments currently active for this content (across its jobs). */
  x: number;
  /** Copies the tier plan wants for this content (the job's own replicas without a tier). */
  wanted: number;
  paid: number;
  /** Every holder assignment under this content's jobs (this job's alone when it has no content id). */
  holders: AssignmentRow[];
}

/**
 * Cross-references one job with the tier plans and the holder assignments.
 *
 * x counts the active holder assignments of the whole content — a content's copies can be
 * filled under any of its jobs, and this is the same number holdersOf() keeps on the node.
 * N is the tier plan's wanted copies: its per-medium copies plus its wanted external URL
 * backups. Without a tier assignment the job's own replica count says how many copies it
 * wants. paid sums what this job's holders have actually received so far.
 */
function viewOf(
  job: StorageJobRow,
  jobs: StorageJobRow[],
  tiers: TierPlan[],
  tierAssignments: TierAssignmentRow[],
  assignments: AssignmentRow[]
): JobView {
  const siblings = jobs.filter((entry) => (job.cid ? entry.cid === job.cid : entry.id === job.id));
  const x = siblings.reduce((sum, entry) => sum + (entry.holders ?? 0), 0);
  const siblingIds = new Set(siblings.map((entry) => entry.id));
  const holders = assignments
    .filter((entry) => siblingIds.has(entry.jobId))
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.acceptedAt.localeCompare(a.acceptedAt));
  const assigned = job.cid ? tierAssignments.find((entry) => entry.cid === job.cid) : undefined;
  const tier = assigned ? tiers.find((entry) => entry.id === assigned.tier) : undefined;
  const wanted = tier
    ? Object.values(tier.media).reduce((sum, count) => sum + (count ?? 0), 0) + (tier.externalUrls ?? 0)
    : job.replicas;
  const paid = holders.filter((entry) => entry.jobId === job.id).reduce((sum, entry) => sum + (entry.earned ?? 0), 0);
  return {
    job,
    tier: tier ? { id: tier.id, label: tier.label } : undefined,
    x,
    wanted,
    paid,
    holders,
  };
}

/**
 * "Credits awarded": what the job pays out. The jobs payload carries no paid-out totals,
 * so the headline number is the honest fixed payout of the job's reward terms — upfront +
 * completion per holder — and the per-retrieval / per-challenge rates go into the tooltip
 * and the details below. The credits holders have actually received so far are summed
 * from /v1/admin/storage/assignments and shown underneath, labelled as paid (that endpoint
 * keeps the 500 most recent assignments, so on a big node it can undercount).
 */
function rewardsTitle(job: StorageJobRow): string {
  return `Per holder: ${job.rewards.upfront} credits when hired + ${job.rewards.completion} at the end of the term, plus ${job.rewards.perRetrieval} per retrieval and ${job.rewards.perChallenge} per passed challenge`;
}

/** The moment the job stops looking for holders, or the end of its paid term. */
function expirationOf(job: StorageJobRow): string | null {
  if (job.openUntil) return job.openUntil;
  const start = Date.parse(job.createdAt);
  if (job.durationSeconds && Number.isFinite(start)) return new Date(start + job.durationSeconds * 1000).toISOString();
  return null;
}

const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

/** One label/value line of the job details. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row between" style={{ gap: 12, alignItems: 'baseline' }}>
      <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span className="small" style={{ textAlign: 'right', overflowWrap: 'anywhere' }}>
        {children}
      </span>
    </div>
  );
}

/** Everything one job record carries, in full, with its holders listed underneath. */
function JobDetails({ view, onClose }: { view: JobView; onClose: () => void }) {
  const { job, tier, x, wanted, paid, holders } = view;
  const cid = job.cid ?? '';
  const [tab, setTab] = useState<'details' | 'jobs'>('details');
  const [details, setDetails] = useState<ContentDetailsData | null>(null);
  const [detailsError, setDetailsError] = useState('');
  // The second tab is the content's own Storage jobs tab, so it needs the content details.
  const loadDetails = useCallback(() => {
    if (!cid) return;
    admin<ContentDetailsData>(`/v1/admin/content/${encodeURIComponent(cid)}`)
      .then(setDetails)
      .catch((e) => setDetailsError(message(e)));
  }, [cid]);
  useEffect(() => {
    if (tab === 'jobs' && !details && !detailsError) loadDetails();
  }, [tab, details, detailsError, loadDetails]);

  const expiration = expirationOf(job);
  const active = holders.filter((entry) => entry.status === 'active');
  const byStatus = new Map<string, number>();
  for (const holder of holders) byStatus.set(holder.status, (byStatus.get(holder.status) ?? 0) + 1);

  return (
    <Modal title="Storage job" onClose={onClose} wide>
      <div className="form-stack" style={{ paddingBottom: 28 }}>
        <div>
          <h3>{job.title ?? (cid ? `${cid.slice(0, 24)}…` : '(no content)')}</h3>
          <div className="row" style={{ gap: 6 }}>
            <span className="mono tiny faint">{cid || 'no content id'}</span>
            {cid ? <CopyButton text={cid} label="Content id" /> : null}
          </div>
        </div>
        <div className="tabs">
          {(
            [
              ['details', 'Job details'],
              ['jobs', 'Storage jobs'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'details' && (
          <div className="form-stack" style={{ gap: 8 }}>
            <Fact label="Content id">
              <span className="mono">{cid || '—'}</span>
            </Fact>
            <Fact label="Title">{job.title ?? '—'}</Fact>
            <Fact label="Job id">
              <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <span className="mono">{job.id}</span>
                <CopyButton text={job.id} label="Id" />
              </span>
            </Fact>
            <Fact label="Status">
              <span className={`badge ${job.status === 'failed' ? 'danger' : job.status === 'open' ? 'accent' : 'ok'}`}>{job.status}</span>
              <div className="tiny faint">{job.managed ? 'opened by the tier by itself' : 'opened by hand'}</div>
            </Fact>
            <Fact label="Tier">
              {tier ? (
                <>
                  <strong>{tier.label}</strong> <span className="tiny faint">({tier.id})</span>
                </>
              ) : (
                <span className="muted">no tier assigned — the job's own copies wanted</span>
              )}
            </Fact>
            <Fact label="Jobs fulfilled">
              <strong>
                {x}/{wanted}
              </strong>{' '}
              jobs fulfilled
              <div className="tiny faint">
                {tier ? 'copies the tier plan wants (its media copies + URL backups)' : 'copies the job wants (its replicas)'}
              </div>
            </Fact>
            <Fact label="Credits awarded">
              <span title={rewardsTitle(job)}>
                {job.rewards.upfront + job.rewards.completion} credits per holder — {job.rewards.upfront} upfront +{' '}
                {job.rewards.completion} at the end of the term
              </span>
              <div className="tiny faint">
                plus {job.rewards.perRetrieval} per retrieval and {job.rewards.perChallenge} per passed challenge
              </div>
              <div className="tiny faint">paid to holders so far: {paid} credits</div>
            </Fact>
            <Fact label="Job start">
              {date(job.createdAt)}
              <div className="tiny faint">{timeAgo(job.createdAt)}</div>
            </Fact>
            <Fact label="Expiration">
              {expiration ? date(expiration) : '—'}
              <div className="tiny faint">{job.openUntil ? 'no new holders after this' : 'end of the paid term'}</div>
            </Fact>
            <Fact label="Open for holders until">{job.openUntil ? date(job.openUntil) : 'until closed by hand'}</Fact>
            <Fact label="Term">
              {job.durationSeconds ? `${Math.round(job.durationSeconds / 86400)} days` : '—'}
              {job.durationSeconds && Number.isFinite(Date.parse(job.createdAt)) ? (
                <div className="tiny faint">
                  ends {date(new Date(Date.parse(job.createdAt) + job.durationSeconds * 1000).toISOString())}
                </div>
              ) : null}
            </Fact>
            <Fact label="Replicas">{job.replicas}</Fact>
            <Fact label="Bytes">{formatBytes(job.bytes)}</Fact>
            <Fact label="Chunks">{job.chunkIds.length}</Fact>
            <Fact label="Requires identity">
              {job.requireIdentity ? 'yes — only key accounts may hold data' : 'no — any account may hold data'}
            </Fact>
            <Fact label="Challenges">
              {job.challengeIntervalSeconds ? `every ${Math.round(job.challengeIntervalSeconds / 60)} minutes` : 'the service default'}
            </Fact>
            <Fact label="Retrieval tests">
              {job.retrievalIntervalSeconds ? `every ${Math.round(job.retrievalIntervalSeconds / 60)} minutes` : 'only on demand'}
            </Fact>
            <Fact label="Slow endpoint">{job.maxLatencyMs !== undefined ? `${job.maxLatencyMs} ms` : 'the service default'}</Fact>
            <Fact label="Fails before an endpoint counts failed">
              {job.failedRequestsBeforeFailure !== undefined ? job.failedRequestsBeforeFailure : 'the service default'}
            </Fact>
            <Fact label="Last endpoint test">
              {job.lastEndpointTestAt ? date(new Date(job.lastEndpointTestAt).toISOString()) : 'never'}
            </Fact>
            <Fact label="Assignments">
              {job.assignments} total · {job.holders} active
            </Fact>

            <h3 style={{ marginTop: 12 }}>
              {x}/{wanted} jobs fulfilled
            </h3>
            <p className="tiny faint" style={{ margin: 0 }}>
              Holder assignments under this content's jobs — the ones currently active are counted in the fraction above.
            </p>
            {holders.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Holder</th>
                    <th>Status</th>
                    <th>Earned</th>
                    <th>Challenges</th>
                    <th>Accepted</th>
                  </tr>
                </thead>
                <tbody>
                  {holders.map((holder) => (
                    <tr key={holder.id}>
                      <td className="mono tiny">{holder.accountId}</td>
                      <td>
                        <span className={`badge ${holder.status === 'failed' ? 'danger' : holder.status === 'active' ? 'ok' : ''}`}>
                          {holder.status}
                        </span>
                      </td>
                      <td className="small">{holder.earned} credits</td>
                      <td className="small">
                        {holder.challenges.passed} passed · {holder.challenges.failed} failed · {holder.retrievals} retrievals
                      </td>
                      <td className="tiny faint">
                        {timeAgo(holder.acceptedAt)}
                        <div>{date(holder.expiresAt)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="small muted">No holder assignments under this content's jobs yet.</p>
            )}
            <div className="tiny faint">
              {active.length} active
              {[...byStatus]
                .filter(([status]) => status !== 'active')
                .map(([status, count]) => ` · ${count} ${status}`)
                .join('')}
            </div>
          </div>
        )}
        {tab === 'jobs' &&
          (cid ? (
            detailsError ? (
              <div className="banner danger small">{detailsError}</div>
            ) : details ? (
              <StorageJobsTab data={details} cid={cid} reload={loadDetails} />
            ) : (
              <Loading />
            )
          ) : (
            <p className="small muted">This job has no content id — there is no content behind it.</p>
          ))}
      </div>
    </Modal>
  );
}

/** The Storage Jobs page: the node's storage jobs, searchable and paged or lazy-loaded. */
export function StorageJobs() {
  const [jobs, setJobs] = useState<StorageJobRow[] | null>(null);
  const [tiers, setTiers] = useState<TierPlan[]>([]);
  const [tierAssignments, setTierAssignments] = useState<TierAssignmentRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [search, setSearch] = useState('');
  const [paged, setPaged] = useState(true);
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(25);
  const [opened, setOpened] = useState<JobView | null>(null);
  const [toast, show] = useToast();

  const load = useCallback(() => {
    admin<{ jobs: StorageJobRow[] }>('/v1/admin/storage/jobs')
      .then((r) => setJobs(r.jobs ?? []))
      .catch((e) => show(message(e)));
    admin<{ config: { tiers: TierPlan[] }; assignments: TierAssignmentRow[] }>('/v1/admin/tiers')
      .then((r) => {
        setTiers(r.config?.tiers ?? []);
        setTierAssignments(r.assignments ?? []);
      })
      .catch((e) => show(message(e)));
    // The holders and the credits paid so far only decorate the rows: when this one does
    // not answer, the counts from the jobs themselves still fill the table.
    admin<{ assignments: AssignmentRow[] }>('/v1/admin/storage/assignments')
      .then((r) => setAssignments(r.assignments ?? []))
      .catch(() => undefined);
  }, [show]);
  useEffect(load, [load]);

  // A search matches the tier (id or label), the content id (substring or prefix) or the
  // job's name.
  const query = search.trim().toLowerCase();
  const views = (jobs ?? []).map((job) => viewOf(job, jobs ?? [], tiers, tierAssignments, assignments));
  const filtered = views.filter(
    (view) =>
      !query ||
      (view.job.cid ?? '').toLowerCase().includes(query) ||
      (view.job.title ?? '').toLowerCase().includes(query) ||
      (view.tier?.id ?? '').toLowerCase().includes(query) ||
      (view.tier?.label ?? '').toLowerCase().includes(query)
  );
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages - 1);
  const visible = paged ? filtered.slice(current * size, current * size + size) : filtered.slice(0, shown);

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="row">
        <input
          type="search"
          value={search}
          placeholder="Search by tier, content id or job name"
          style={{ flex: 1 }}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
            setShown(size);
          }}
        />
      </div>
      {!jobs ? (
        <Loading />
      ) : jobs.length === 0 ? (
        <p className="small muted">
          No storage jobs on this node yet. One is opened for every upload when the storage service runs by itself, and by hand from a
          content's details.
        </p>
      ) : (
        <>
          <div className="row between small">
            <span className="muted">
              {filtered.length} job{filtered.length === 1 ? '' : 's'}
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
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Content</th>
                  <th>Tier</th>
                  <th>Credits awarded</th>
                  <th>Job start</th>
                  <th>Expiration</th>
                  <th>Jobs fulfilled</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={6} className="small muted">
                      No storage jobs match.
                    </td>
                  </tr>
                )}
                {visible.map((view) => {
                  const { job, tier, x, wanted, paid } = view;
                  const expiration = expirationOf(job);
                  return (
                    <tr key={job.id} style={{ cursor: 'pointer' }} title="Open the job" onClick={() => setOpened(view)}>
                      <td>
                        <strong>{job.title ?? (job.cid ? `${job.cid.slice(0, 20)}…` : '(no content)')}</strong>
                        <div className="mono tiny faint" title={job.cid}>
                          {job.cid ? job.cid.slice(-12) : '—'}
                        </div>
                        <div className="tiny faint">
                          {job.status}
                          {job.managed ? ' · automatic' : ''}
                        </div>
                      </td>
                      <td className="small">
                        {tier ? (
                          <>
                            <strong>{tier.label}</strong>
                            <div className="tiny faint">{tier.id}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="small">
                        <span title={rewardsTitle(job)}>{job.rewards.upfront + job.rewards.completion} credits</span>
                        <div className="tiny faint" title="Credits this job's holders have actually received so far">
                          {paid} paid to holders so far
                        </div>
                      </td>
                      <td className="small">
                        {date(job.createdAt)}
                        <div className="tiny faint">{timeAgo(job.createdAt)}</div>
                      </td>
                      <td className="small">
                        {expiration ? (
                          <>
                            {date(expiration)}
                            <div className="tiny faint">{job.openUntil ? 'open until' : 'term ends'}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="small">
                        {x}/{wanted} jobs fulfilled
                        <div className="tiny faint">
                          {x >= wanted ? 'all copies held' : `${wanted - x} cop${wanted - x === 1 ? 'y' : 'ies'} still wanted`}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!paged && visible.length < filtered.length && (
            <button className="small" onClick={() => setShown(shown + size)}>
              Load more ({filtered.length - visible.length} left)
            </button>
          )}
        </>
      )}
      {opened && <JobDetails view={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}