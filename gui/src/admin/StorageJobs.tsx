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
  rewards: { upfront: number; perRetrieval: number; completion: number };
  requireIdentity: boolean;
  createdAt: string;
  openUntil?: string;
  status: 'open' | 'closed' | 'failed';
  managed?: boolean;
  /** Times the job was reopened after a failed holder. */
  reopened?: number;
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
 * The payout of a job's credits in words. What holders have actually been paid is the
 * number the column leads with (summed from /v1/admin/storage/assignments, which keeps
 * the 500 most recent assignments, so on a big node it can undercount); this and the
 * payout line under the number give the reward terms behind it.
 */
function rewardsTitle(job: StorageJobRow): string {
  return `Per holder: ${job.rewards.upfront} credits when hired + ${job.rewards.completion} at the end of the term, plus ${job.rewards.perRetrieval} per retrieval`;
}

/** The four payout numbers of a job: upfront, per retrieval, time between retrievals, finish. */
function payoutLine(job: StorageJobRow): string {
  return `${job.rewards.upfront} upfront · ${job.rewards.perRetrieval} per retrieval · every ${Math.round((job.retrievalIntervalSeconds ?? 0) / 60)} min · ${job.rewards.completion} at the end`;
}

/** The moment the job stops looking for holders, or the end of its paid term. */
function expirationOf(job: StorageJobRow): string | null {
  if (job.openUntil) return job.openUntil;
  const start = Date.parse(job.createdAt);
  if (job.durationSeconds && Number.isFinite(start)) return new Date(start + job.durationSeconds * 1000).toISOString();
  return null;
}

const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

/** "in 3 days" / "2 hours ago" — how far an absolute date is from now, "—" without one. */
function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return '—';
  const future = seconds >= 0;
  const away = Math.abs(seconds);
  if (away < 60) return future ? 'in a moment' : 'just now';
  const steps: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ];
  let label = 'minute';
  let size = 60;
  for (const [step, name] of steps) {
    if (away >= step) {
      size = step;
      label = name;
    }
  }
  const count = Math.floor(away / size);
  return future ? `in ${count} ${label}${count === 1 ? '' : 's'}` : `${count} ${label}${count === 1 ? '' : 's'} ago`;
}

/**
 * One label/value line of the job details. The two are cells of one grid below, so every
 * label sits in the same fixed-width column and every value starts at the same place.
 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="small muted" style={{ textAlign: 'right' }}>
        {label}
      </span>
      <span className="small" style={{ overflowWrap: 'anywhere' }}>
        {children}
      </span>
    </>
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
            {/* One grid for all facts: the labels share a fixed-width, right-aligned
                column and the values all start right after it. */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '160px minmax(0, 1fr)',
                columnGap: 12,
                rowGap: 8,
                alignItems: 'baseline',
              }}
            >
              <Fact label="Content id">
                <span className="mono">{cid || '—'}</span>
              </Fact>
              <Fact label="Title">{job.title ?? '—'}</Fact>
              <Fact label="Job id">
                <span className="row" style={{ gap: 6 }}>
                  <span className="mono">{job.id}</span>
                  <CopyButton text={job.id} label="Id" />
                </span>
              </Fact>
              <Fact label="Status">
                <span className={`badge ${job.status === 'failed' ? 'danger' : job.status === 'open' ? 'accent' : 'ok'}`}>{job.status}</span>{' '}
                {job.reopened ? (
                  <span className="badge warn" title="A holder failed and was removed — the job opened again for the freed copy">
                    Reopened {job.reopened} time{job.reopened === 1 ? '' : 's'} after failed holders
                  </span>
                ) : null}
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
                <div className="tiny faint">plus {job.rewards.perRetrieval} per retrieval</div>
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
            </div>

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
                        {/* A removed holder failed and was deleted from the job — kept visible, never counted as active. */}
                        <span
                          className={`badge ${holder.status === 'failed' || holder.status === 'removed' ? 'danger' : holder.status === 'active' ? 'ok' : ''}`}
                          title={holder.status === 'removed' ? 'This user failed and was deleted from the job (kept visible here)' : undefined}
                        >
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
  const [jump, setJump] = useState('');
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
  // Skipping to a page by number: whatever is typed is clamped to the pages that exist.
  const skipTo = () => {
    const wanted = Math.round(Number(jump));
    if (!jump.trim() || !Number.isFinite(wanted)) return;
    const target = Math.min(pages, Math.max(1, wanted));
    setPage(target - 1);
    setJump(String(target));
  };
  // The same pager above and below the rows — one page of jobs can be long.
  const summary = (
    <span className="muted">
      {filtered.length} job{filtered.length === 1 ? '' : 's'}
      {paged ? ` · page ${current + 1} of ${pages}` : ` · showing ${visible.length}`}
    </span>
  );
  const pagerButtons = (
    <>
      <button className="small" disabled={current === 0} onClick={() => setPage(current - 1)}>
        Previous
      </button>
      <button className="small" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
        Next
      </button>
    </>
  );

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      {/* Row 1 of the controls: what to look for, how to page and how much at once. */}
      <div className="row small">
        <input
          type="search"
          value={search}
          placeholder="Search by tier, content id or job name"
          style={{ width: 320, maxWidth: '100%' }}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
            setShown(size);
          }}
        />
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
        <span className="hint">Items per page</span>
        <input
          key={size}
          type="number"
          min={1}
          max={500}
          style={{ maxWidth: 92 }}
          title="Jobs per page (1–500)"
          defaultValue={size}
          onBlur={(e) => {
            const wanted = Math.round(Number(e.target.value));
            if (!e.target.value.trim() || !Number.isFinite(wanted) || wanted === size) return;
            const perPage = Math.min(500, Math.max(1, wanted));
            setSize(perPage);
            setPage(0);
            setShown(perPage);
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
          {/* Row 2 of the controls: the pager, with a skip-to-page at its right end. */}
          <div className="row between small">
            <div className="row" style={{ gap: 6 }}>
              {paged ? (
                <>
                  <button className="small" disabled={current === 0} onClick={() => setPage(current - 1)}>
                    Previous
                  </button>
                  <span className="muted">
                    page {current + 1} of {pages}
                  </span>
                  <button className="small" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                    Next
                  </button>
                </>
              ) : (
                <span className="muted">
                  showing {visible.length} of {filtered.length}
                </span>
              )}
            </div>
            {paged && (
              <div className="row" style={{ gap: 6 }}>
                <span className="hint">Skip to page</span>
                <input
                  type="number"
                  min={1}
                  max={pages}
                  style={{ maxWidth: 80 }}
                  value={jump}
                  placeholder="1"
                  title={`Page to jump to (1–${pages})`}
                  onChange={(e) => setJump(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && skipTo()}
                />
                <button className="small" onClick={skipTo}>
                  Go
                </button>
              </div>
            )}
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
                      <td className="mono tiny" title={job.cid} style={{ overflowWrap: 'anywhere' }}>
                        {job.cid ?? '—'}
                      </td>
                      <td className="small">{tier ? tier.id : <span className="muted">—</span>}</td>
                      <td className="small">
                        <span title="Credits this job's holders have actually received so far">{paid} credits</span>
                        <div className="tiny faint" title={rewardsTitle(job)}>
                          {payoutLine(job)}
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
                            <div className="tiny faint">{relative(expiration)}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="small">
                        {x}/{wanted} jobs fulfilled
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* The same pager again under the rows, where a long page leaves off. */}
          <div className="row between small">
            {summary}
            <div className="row" style={{ gap: 6 }}>
              {paged ? (
                pagerButtons
              ) : visible.length < filtered.length ? (
                <button className="small" onClick={() => setShown(shown + size)}>
                  Load more ({filtered.length - visible.length} left)
                </button>
              ) : null}
            </div>
          </div>
        </>
      )}
      {opened && <JobDetails view={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}