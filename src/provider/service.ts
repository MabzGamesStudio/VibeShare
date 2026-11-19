import { randomId } from '../shared/crypto.js';
import { chunkIdOf } from '../shared/content.js';
import { badRequest, forbidden, HttpError, notFound } from '../shared/node/http.js';
import { log } from '../shared/node/log.js';
import type {
  StorageAssignment,
  StorageOffer,
  StorageRewards,
  StorageTask,
} from '../shared/protocol.js';
import { JsonFile } from '../shared/node/store.js';
import type { TraceStore } from '../shared/node/tracing-node.js';
import type { Account, Ledger } from '../node/ledger.js';

export interface StorageServiceConfig {
  enabled: boolean;
  /** Seconds between automatic test retrievals per assignment (0 = only on demand). */
  retrievalIntervalSeconds: number;
  /** A client that has not polled for this long counts as offline (its retrievals fail). */
  offlineGraceSeconds: number;
  /** Seconds a client gets to answer a task. */
  taskTimeoutSeconds: number;
  /** Create a storage job for every new upload. */
  auto: {
    enabled: boolean;
    replicas: number;
    durationDays: number;
    rewards: StorageRewards;
    /** Retrieval schedule of the jobs this node opens by itself. */
    retrievalIntervalSeconds: number;
    requireIdentity: boolean;
  };
}

export interface StorageJob {
  id: string;
  cid?: string;
  title?: string;
  chunkIds: string[];
  bytes: number;
  replicas: number;
  durationSeconds: number;
  rewards: StorageRewards;
  requireIdentity: boolean;
  createdAt: string;
  /** No new assignments after this time (undefined = open until closed). */
  openUntil?: string;
  status: 'open' | 'closed' | 'failed';
  /** True for the tier-driven job the node opens and resizes by itself. */
  managed?: boolean;
  /** How often the job's endpoints are tested automatically (0 or undefined = only on demand). */
  retrievalIntervalSeconds?: number;
  /** Endpoints slower than this many milliseconds count as failed checks. */
  maxLatencyMs?: number;
  /** Consecutive failed requests before an endpoint counts as failed. */
  failedRequestsBeforeFailure?: number;
  /** When the last automatic endpoint test ran (schedule: job.retrievalIntervalSeconds). */
  lastEndpointTestAt?: number;
  /** How often the job was reopened for another client after a holder was removed. */
  reopened: number;
}

interface Assignment extends StorageAssignment {
  accountId: string;
  upfrontPaid: boolean;
  /** Consecutive failed endpoint checks — the holder is removed only after enough. */
  failedChecks?: number;
}

interface ServiceData {
  jobs: Record<string, StorageJob>;
  assignments: Record<string, Assignment>;
}

interface PendingTask extends StorageTask {
  accountId: string;
  delivered: boolean;
  /** For retrievals the provider is waiting on. */
  waiters: ((data: Buffer | null) => void)[];
}

const LIVE: Assignment['status'][] = ['downloading', 'active'];

/** The three reward fields, picked over the defaults — never any stale extras. */
function rewardsOf(partial: Partial<StorageRewards> | undefined, base: StorageRewards): StorageRewards {
  return {
    upfront: partial?.upfront ?? base.upfront,
    perRetrieval: partial?.perRetrieval ?? base.perRetrieval,
    completion: partial?.completion ?? base.completion,
  };
}

/**
 * Client nodes can earn credits by storing data for this provider. The provider
 * publishes jobs (what to store, for how long, for which rewards); clients accept
 * them, download the chunks, and keep a long-poll open through which the provider
 * sends tasks: retrieve a chunk (paid per retrieval). The long poll goes out from
 * the client, so it works behind NAT and firewalls.
 */
export class StorageService {
  private store: JsonFile<ServiceData>;
  private tasks = new Map<string, PendingTask>();
  private pollers = new Map<string, Set<() => void>>();
  private lastPoll = new Map<string, number>();
  private timer: NodeJS.Timeout;

  constructor(
    path: string | null,
    private readonly ledger: Ledger,
    private readonly config: () => StorageServiceConfig,
    /** Reads a chunk; `peers: false` restricts it to the provider's own storage. */
    private readonly readChunk: (id: string, options?: { peers?: boolean }) => Promise<Buffer | null>,
    /** A holder that failed a retrieval: the node pulls the job's data from their URLs instead. */
    private readonly onHolderOut?: (accountId: string, job?: StorageJob) => void,
    /** The node's trace log (off by default; absent keeps every hook a no-op). */
    private readonly traces?: TraceStore
  ) {
    this.store = new JsonFile<ServiceData>(path, () => ({ jobs: {}, assignments: {} }));
    this.timer = setInterval(() => void this.tick().catch((error) => log.warn('storage service tick:', error)), 5000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const task of this.tasks.values()) for (const waiter of task.waiters) waiter(null);
    this.tasks.clear();
    this.store.flush();
  }

  private get data(): ServiceData {
    return this.store.data;
  }

  // -------------------------------------------------------------------------
  // Jobs (operator)

  createJob(input: {
    cid?: string;
    title?: string;
    chunks: { id: string; size: number }[];
    replicas?: number;
    durationSeconds?: number;
    rewards?: Partial<StorageRewards>;
    requireIdentity?: boolean;
    openUntil?: string;
    managed?: boolean;
    retrievalIntervalSeconds?: number;
    maxLatencyMs?: number;
    failedRequestsBeforeFailure?: number;
  }): StorageJob {
    if (!input.chunks.length) throw badRequest('A job needs at least one chunk');
    const unique = new Map(input.chunks.map((chunk) => [chunk.id, chunk.size]));
    // The operator's job replaces the automatic tier job for the same content.
    if (input.cid) for (const job of Object.values(this.data.jobs)) {
      if (job.managed && job.cid === input.cid) this.deleteJob(job.id);
    }
    const job: StorageJob = {
      id: randomId('job-', 8),
      cid: input.cid,
      title: input.title,
      chunkIds: [...unique.keys()],
      bytes: [...unique.values()].reduce((sum, size) => sum + size, 0),
      replicas: Math.max(1, Math.floor(input.replicas ?? 2)),
      durationSeconds: Math.max(60, Math.floor(input.durationSeconds ?? 30 * 86400)),
      rewards: rewardsOf(input.rewards, { upfront: 0, perRetrieval: 1, completion: 10 }),
      requireIdentity: input.requireIdentity ?? false,
      createdAt: new Date().toISOString(),
      openUntil: input.openUntil,
      status: 'open',
      managed: input.managed,
      retrievalIntervalSeconds: input.retrievalIntervalSeconds,
      maxLatencyMs: input.maxLatencyMs,
      failedRequestsBeforeFailure: input.failedRequestsBeforeFailure,
      reopened: 0,
    };
    this.data.jobs[job.id] = job;
    this.store.changed();
    this.traces?.trace('basic', 'provider.service', 'job created', {
      data: { job: job.id, cid: job.cid?.slice(0, 16), chunks: job.chunkIds.length, bytes: job.bytes, replicas: job.replicas, managed: job.managed ?? false },
    });
    return job;
  }

  /** Updates one job's rewards and its retrieval / endpoint-test schedule. */
  updateJob(
    id: string,
    patch: {
      rewards?: Partial<StorageRewards>;
      retrievalIntervalSeconds?: number;
      maxLatencyMs?: number;
      failedRequestsBeforeFailure?: number;
    }
  ): void {
    const job = this.data.jobs[id];
    if (!job) throw notFound('No such job');
    if (patch.rewards) job.rewards = rewardsOf(patch.rewards, job.rewards);
    if (patch.retrievalIntervalSeconds !== undefined) job.retrievalIntervalSeconds = Math.max(0, Math.round(patch.retrievalIntervalSeconds));
    if (patch.maxLatencyMs !== undefined) job.maxLatencyMs = Math.max(50, Math.round(patch.maxLatencyMs));
    if (patch.failedRequestsBeforeFailure !== undefined) job.failedRequestsBeforeFailure = Math.max(1, Math.round(patch.failedRequestsBeforeFailure));
    this.store.changed();
    this.traces?.trace('basic', 'provider.service', 'job updated', { data: { job: id } });
  }

  closeJob(id: string): void {
    const job = this.data.jobs[id];
    if (!job) throw notFound('No such job');
    job.status = 'closed';
    this.store.changed();
    this.traces?.trace('basic', 'provider.service', 'job closed', { data: { job: id } });
  }

  /** Removes a job entirely: its assignments and pending tasks go with it. */
  deleteJob(id: string): boolean {
    if (!this.data.jobs[id]) return false;
    delete this.data.jobs[id];
    for (const [taskId, task] of [...this.tasks]) {
      if (this.data.assignments[task.assignmentId]?.jobId === id) {
        this.tasks.delete(taskId);
        for (const waiter of task.waiters) waiter(null);
      }
    }
    for (const [assignmentId, assignment] of Object.entries(this.data.assignments)) {
      if (assignment.jobId === id) delete this.data.assignments[assignmentId];
    }
    this.store.changed();
    this.traces?.trace('basic', 'provider.service', 'job deleted', { data: { job: id } });
    return true;
  }

  /** Marks a job failed: no endpoint and no holder could serve its data any more. */
  failJob(id: string): void {
    const job = this.data.jobs[id];
    if (!job || job.status === 'failed') return;
    job.status = 'failed';
    this.store.changed();
    // Not a crash — the job simply has nowhere left to get its data from.
    this.traces?.trace('error', 'provider.service', 'job failed', { message: 'no endpoint and no holder can serve the data', data: { job: id, cid: job.cid?.slice(0, 16) } });
  }

  jobs(): (StorageJob & { holders: number; assignments: number })[] {
    return Object.values(this.data.jobs)
      .map((job) => ({
        ...job,
        // Jobs saved before reopenings existed still report zero.
        reopened: job.reopened ?? 0,
        holders: this.liveAssignments(job.id).filter((a) => a.status === 'active').length,
        assignments: Object.values(this.data.assignments).filter((a) => a.jobId === job.id).length,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  assignmentsForAdmin(): Assignment[] {
    return Object.values(this.data.assignments).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  }

  private liveAssignments(jobId: string): Assignment[] {
    return Object.values(this.data.assignments).filter((a) => a.jobId === jobId && LIVE.includes(a.status));
  }

  private isOpen(job: StorageJob): boolean {
    return job.status === 'open' && (!job.openUntil || Date.parse(job.openUntil) > Date.now());
  }

  openJobCount(): number {
    return Object.values(this.data.jobs).filter((job) => this.isOpen(job) && this.liveAssignments(job.id).length < job.replicas).length;
  }

  // -------------------------------------------------------------------------
  // Client side

  offers(account: Account): StorageOffer[] {
    if (!this.config().enabled) return [];
    // A job the account already holds — or lost to failing checks — is never offered to
    // it again; a completed term reopens the offer, and a release forgets the row
    // entirely (so there is nothing left to exclude).
    const mine = new Set(
      Object.values(this.data.assignments)
        .filter((a) => a.accountId === account.id && a.status !== 'completed')
        .map((a) => a.jobId)
    );
    return Object.values(this.data.jobs)
      .filter((job) => this.isOpen(job) && !mine.has(job.id))
      .map((job) => ({ job, slots: job.replicas - this.liveAssignments(job.id).length }))
      .filter(({ slots }) => slots > 0)
      .map(({ job, slots }) => ({
        id: job.id,
        cid: job.cid,
        title: job.title,
        chunks: job.chunkIds.length,
        bytes: job.bytes,
        durationSeconds: job.durationSeconds,
        rewards: job.rewards,
        slots,
        requireIdentity: job.requireIdentity,
      }));
  }

  /**
   * Takes one slot of one job. The upfront reward is earned by being live right away:
   * the endpoint the account submitted must serve the content at this moment —
   * otherwise it is paid the first time an endpoint check passes, or never.
   */
  async accept(
    account: Account,
    jobId: string,
    checkEndpoint?: (accountId: string, job: StorageJob) => Promise<boolean>
  ): Promise<StorageAssignment> {
    if (!this.config().enabled) throw forbidden('The storage service is turned off');
    const job = this.data.jobs[jobId];
    if (!job || !this.isOpen(job)) throw notFound('No such open job');
    if (job.requireIdentity && account.kind !== 'key') throw forbidden('This job needs a key-based account');
    if (this.liveAssignments(job.id).length >= job.replicas) throw new HttpError(409, 'full', 'The job has no free slots');
    if (this.liveAssignments(job.id).some((a) => a.accountId === account.id)) {
      throw new HttpError(409, 'duplicate', 'You already store this job');
    }
    // One copy per user: never two assignments of the same content on one account, even
    // across separate jobs.
    if (job.cid && Object.values(this.data.assignments).some((a) => a.accountId === account.id && LIVE.includes(a.status) && this.data.jobs[a.jobId]?.cid === job.cid)) {
      throw new HttpError(409, 'duplicate', 'You already store a copy of this content');
    }
    const now = Date.now();
    const assignment: Assignment = {
      id: randomId('asg-', 8),
      jobId: job.id,
      accountId: account.id,
      chunkIds: job.chunkIds,
      bytes: job.bytes,
      status: 'downloading',
      acceptedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + job.durationSeconds * 1000).toISOString(),
      retrievals: 0,
      earned: 0,
      upfrontPaid: false,
    };
    this.data.assignments[assignment.id] = assignment;
    this.store.changed();
    this.traces?.trace('basic', 'provider.service', 'assignment accepted', {
      data: { assignment: assignment.id, job: job.id, account: account.id.slice(0, 16), bytes: job.bytes },
    });
    if (await checkEndpoint?.(account.id, job)) this.payUpfront(assignment);
    return this.view(assignment);
  }

  /**
   * Pays the one-time upfront reward — only for a holder whose submitted endpoint is
   * (or has become) live, and only ever once per assignment.
   */
  private payUpfront(assignment: Assignment): void {
    if (assignment.upfrontPaid || !LIVE.includes(assignment.status)) return;
    assignment.upfrontPaid = true;
    const reward = this.data.jobs[assignment.jobId]?.rewards.upfront ?? 0;
    if (reward > 0) {
      assignment.earned += reward;
      this.ledger.credit(assignment.accountId, reward, 'storage upfront', assignment.id);
      this.traces?.trace('basic', 'provider.service', 'reward paid', {
        data: { account: assignment.accountId.slice(0, 16), type: 'upfront', credits: reward, assignment: assignment.id },
      });
    }
    this.store.changed();
  }

  /**
   * An endpoint of this holder passed a check: whatever earlier failures made of it,
   * the holder counts now. The failure streak resets, a still-downloading holder goes
   * active, and one removed by a failed check round comes back while the job has room —
   * the admin's test is an explicit operator action, so it heals the old one-strike
   * damage at once. A job marked failed says nothing else once the content is
   * reachable again. The one-time upfront reward is paid here if still owed.
   */
  endpointLive(assignmentId: string): void {
    const assignment = this.data.assignments[assignmentId];
    if (!assignment) return;
    assignment.failedChecks = 0;
    const job = this.data.jobs[assignment.jobId];
    if (job && job.status === 'failed') job.status = 'open';
    const room = !job || this.liveAssignments(job.id).length < job.replicas;
    const termOver = Date.parse(assignment.expiresAt) <= Date.now();
    // Any copy whose URL serves counts again, whatever the node had made of it before:
    // a downloading holder goes active, and one that was dropped (removed) or was
    // marked failed comes back while the job has room and its term is still running.
    // An explicit check is the operator saying "this endpoint works".
    const restored =
      assignment.status === 'downloading' || (!LIVE.includes(assignment.status) && room && !termOver);
    if (restored) assignment.status = 'active';
    this.store.changed();
    if (restored && assignment.status === 'active') {
      this.traces?.trace('basic', 'provider.service', 'holder restored', {
        message: 'an endpoint check passed',
        data: { assignment: assignment.id, job: assignment.jobId, account: assignment.accountId.slice(0, 16) },
      });
    }
    this.payUpfront(assignment);
  }

  /**
   * One failed endpoint check for a holder: a strike. Nothing else happens until enough
   * strikes pile up without a success in between — then the caller removes the holder
   * with failHolder(). Returns the strike count (0 for a holder no longer in the job).
   */
  noteFailedCheck(assignmentId: string): number {
    const assignment = this.data.assignments[assignmentId];
    if (!assignment || !LIVE.includes(assignment.status)) return 0;
    assignment.failedChecks = (assignment.failedChecks ?? 0) + 1;
    this.store.changed();
    this.traces?.trace('error', 'provider.service', 'holder check failed', {
      message: `${assignment.failedChecks} consecutive failed check${assignment.failedChecks === 1 ? '' : 's'}`,
      data: { assignment: assignment.id, job: assignment.jobId, account: assignment.accountId.slice(0, 16), failed: assignment.failedChecks },
    });
    return assignment.failedChecks;
  }

  private own(account: Account, id: string): Assignment {
    const assignment = this.data.assignments[id];
    if (!assignment || assignment.accountId !== account.id) throw notFound('No such assignment');
    return assignment;
  }

  /** Bytes of a chunk for an assignment being downloaded or held (free of charge). */
  async assignmentChunk(account: Account, assignmentId: string, chunkId: string): Promise<Buffer> {
    const assignment = this.own(account, assignmentId);
    if (!LIVE.includes(assignment.status) || !assignment.chunkIds.includes(chunkId)) throw notFound('Not part of the assignment');
    const data = await this.readChunk(chunkId);
    if (!data) throw notFound('The provider cannot read this chunk right now');
    return data;
  }

  ready(account: Account, assignmentId: string): StorageAssignment {
    const assignment = this.own(account, assignmentId);
    if (assignment.status !== 'downloading') return this.view(assignment);
    assignment.status = 'active';
    this.store.changed();
    this.traces?.trace('basic', 'provider.service', 'assignment active', { data: { assignment: assignment.id, job: assignment.jobId } });
    return this.view(assignment);
  }

  /**
   * Gives a job back: the assignment is forgotten entirely — as if it never existed.
   * The slot frees and the job reopens for another client at once; the ack still
   * answers with the released view for the caller.
   */
  release(account: Account, assignmentId: string): StorageAssignment {
    const assignment = this.own(account, assignmentId);
    const ack: StorageAssignment = { ...this.view(assignment), status: 'released' };
    if (LIVE.includes(assignment.status)) this.forgetAssignment(assignment);
    return ack;
  }

  /**
   * Removes an assignment from the book entirely: the record goes (nothing is left to
   * show or restore later), the slot frees, and the job reopens for another client —
   * counted like the other reopenings.
   */
  private forgetAssignment(assignment: Assignment): void {
    delete this.data.assignments[assignment.id];
    this.store.changed();
    const job = this.data.jobs[assignment.jobId];
    if (job && job.status !== 'failed') {
      if (job.status === 'closed') job.status = 'open';
      job.reopened = (job.reopened ?? 0) + 1;
    }
    this.traces?.trace('basic', 'provider.service', 'assignment released', {
      message: 'forgotten entirely — the job reopens for another client',
      data: { assignment: assignment.id, job: assignment.jobId, account: assignment.accountId.slice(0, 16) },
    });
    this.store.flush();
  }

  mine(account: Account): StorageAssignment[] {
    return Object.values(this.data.assignments)
      .filter((a) => a.accountId === account.id)
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))
      .slice(0, 200)
      .map((a) => this.view(a));
  }

  private view(assignment: Assignment): StorageAssignment {
    const { accountId: _account, upfrontPaid: _paid, ...rest } = assignment;
    const job = this.data.jobs[assignment.jobId];
    return { ...rest, cid: job?.cid, title: job?.title };
  }

  /** Long poll: returns undelivered tasks, waiting up to `waitSeconds` for one. */
  async poll(account: Account, waitSeconds: number): Promise<StorageTask[]> {
    this.lastPoll.set(account.id, Date.now());
    const take = () => {
      const out: StorageTask[] = [];
      for (const task of this.tasks.values()) {
        if (task.accountId !== account.id || task.delivered) continue;
        task.delivered = true;
        out.push({ id: task.id, type: task.type, assignmentId: task.assignmentId, chunkId: task.chunkId, deadline: task.deadline });
      }
      return out;
    };
    const ready = take();
    if (ready.length || waitSeconds <= 0) return ready;
    await new Promise<void>((resolve) => {
      const set = this.pollers.get(account.id) ?? new Set();
      const wake = () => {
        clearTimeout(timer);
        set.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(waitSeconds, 30) * 1000);
      set.add(wake);
      this.pollers.set(account.id, set);
    });
    this.lastPoll.set(account.id, Date.now());
    return take();
  }

  private wake(accountId: string): void {
    for (const wake of [...(this.pollers.get(accountId) ?? [])]) wake();
  }

  private isOnline(accountId: string): boolean {
    const last = this.lastPoll.get(accountId);
    const polling = (this.pollers.get(accountId)?.size ?? 0) > 0;
    return polling || (last !== undefined && Date.now() - last < this.config().offlineGraceSeconds * 1000);
  }

  private addTask(task: Omit<PendingTask, 'id' | 'delivered' | 'waiters' | 'deadline'>): PendingTask {
    const full: PendingTask = {
      ...task,
      id: randomId('task-', 8),
      delivered: false,
      waiters: [],
      deadline: new Date(Date.now() + this.config().taskTimeoutSeconds * 1000).toISOString(),
    };
    this.tasks.set(full.id, full);
    this.wake(task.accountId);
    return full;
  }

  /** The client answers a task: the bytes of a retrieval, hashed against the chunk id. */
  async answer(account: Account, taskId: string, body: Buffer): Promise<{ credited: number }> {
    const task = this.tasks.get(taskId);
    if (!task || task.accountId !== account.id) throw notFound('No such task (it may have timed out)');
    const assignment = this.data.assignments[task.assignmentId];
    this.tasks.delete(taskId);
    if (!assignment) return { credited: 0 };
    const job = this.data.jobs[assignment.jobId];
    const ok = chunkIdOf(body) === task.chunkId;
    for (const waiter of task.waiters) waiter(ok ? body : null);
    let credited = 0;
    if (ok) {
      assignment.retrievals++;
      credited += job?.rewards.perRetrieval ?? 0;
    }
    if (credited > 0) {
      assignment.earned += credited;
      this.ledger.credit(account.id, credited, `storage ${task.type}`, assignment.id);
      this.traces?.trace('basic', 'provider.service', 'reward paid', {
        data: { account: account.id.slice(0, 16), type: task.type, credits: credited, assignment: assignment.id },
      });
    }
    this.store.changed();
    if (!ok) {
      // Wrong bytes mean the holder does not really have the data: out of the job right
      // away, and the node pulls the data from their URLs instead.
      this.eliminate(assignment);
      throw badRequest('The bytes do not match the chunk');
    }
    return { credited };
  }

  /**
   * A holder that fails is deleted from the job: the row stays for display (status
   * 'removed'), the slot frees and the job reopens for another client — however often
   * that happens. The node pulls the job's data from the URLs that account offered
   * instead and looks for other holders.
   */
  private eliminate(assignment: Assignment): void {
    if (!LIVE.includes(assignment.status)) return;
    assignment.status = 'removed';
    this.store.changed();
    // The job was not accepting anyone (full or closed) and now it is again: that is a
    // reopen, and the count is what the dashboard shows for it.
    const job = this.data.jobs[assignment.jobId];
    if (job && job.status !== 'failed') {
      if (job.status === 'closed') job.status = 'open';
      job.reopened = (job.reopened ?? 0) + 1;
    }
    // A tolerated failure: the holder is out, but the job lives on (URLs and other holders).
    this.traces?.trace('error', 'provider.service', 'holder removed', {
      message: 'a holder no longer counts for this job',
      data: { assignment: assignment.id, job: assignment.jobId, account: assignment.accountId.slice(0, 16) },
    });
    this.onHolderOut?.(assignment.accountId, this.data.jobs[assignment.jobId]);
  }

  /**
   * Marks one holder out of the job — used when every endpoint of that user failed its
   * checks. The slot frees and the job reopens for another client.
   */
  failHolder(assignmentId: string): void {
    const assignment = this.data.assignments[assignmentId];
    if (!assignment) throw notFound('No such assignment');
    this.eliminate(assignment);
  }

  /**
   * Asks client nodes holding a chunk for it. Used by the provider when its own
   * backends do not have the chunk (or it chose to rely on clients for it).
   */
  async retrieve(chunkId: string): Promise<Buffer | null> {
    if (!this.config().enabled) return null;
    const holders = Object.values(this.data.assignments).filter(
      (a) => a.status === 'active' && a.chunkIds.includes(chunkId) && this.isOnline(a.accountId)
    );
    if (!holders.length) {
      this.traces?.trace('basic', 'provider.service', 'retrieval skipped', {
        message: 'no online holder has this chunk',
        data: { chunk: chunkId.slice(0, 12) },
      });
      return null;
    }
    const chosen = holders.sort(() => Math.random() - 0.5).slice(0, 2);
    this.traces?.trace('basic', 'provider.service', 'retrieval scheduled', { data: { chunk: chunkId.slice(0, 12), holders: chosen.length } });
    return new Promise<Buffer | null>((resolve) => {
      let pending = chosen.length;
      let done = false;
      const settle = (data: Buffer | null) => {
        done = true;
        clearTimeout(timer);
        this.traces?.trace('basic', 'provider.service', 'retrieval result', {
          data: { chunk: chunkId.slice(0, 12), ok: Boolean(data), bytes: data?.length ?? 0 },
        });
        resolve(data);
      };
      const timer = setTimeout(() => !done && settle(null), this.config().taskTimeoutSeconds * 1000);
      const finish = (data: Buffer | null) => {
        if (done) return;
        if (data) settle(data);
        else if (--pending <= 0) settle(null);
      };
      for (const holder of chosen) {
        const task = this.addTask({ type: 'retrieve', assignmentId: holder.id, accountId: holder.accountId, chunkId });
        task.waiters.push((data) => finish(data));
      }
    });
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (Date.parse(task.deadline) > now) continue;
      this.tasks.delete(id);
      for (const waiter of task.waiters) waiter(null);
      // A missed deadline is a tolerated failure: the holder pays for it, not this node.
      this.traces?.trace('error', 'provider.service', 'task timed out', {
        message: `no answer to the ${task.type} in time`,
        data: { task: id, type: task.type, assignment: task.assignmentId, account: task.accountId.slice(0, 16) },
      });
      // A retrieval nobody answered: that holder's copy does not count any more.
      const assignment = this.data.assignments[task.assignmentId];
      if (assignment) this.eliminate(assignment);
    }
    for (const assignment of Object.values(this.data.assignments)) {
      if (!LIVE.includes(assignment.status)) continue;
      if (Date.parse(assignment.expiresAt) <= now) {
        this.finish(assignment);
        continue;
      }
      // An assignment that never finished downloading gives its slot back entirely —
      // forgotten, like a release: the job opens for others instead of waiting on a
      // client that never stored anything.
      if (assignment.status === 'downloading' && now - Date.parse(assignment.acceptedAt) > 15 * 60_000) {
        this.forgetAssignment(assignment);
        continue;
      }
    }
  }

  private finish(assignment: Assignment): void {
    const job = this.data.jobs[assignment.jobId];
    // Still holding the data when the term ends: the completion reward is due. (A holder
    // that failed along the way was already removed from the job.)
    if (assignment.status === 'active') {
      assignment.status = 'completed';
      const reward = job?.rewards.completion ?? 0;
      if (reward > 0) {
        assignment.earned += reward;
        this.ledger.credit(assignment.accountId, reward, 'storage completed', assignment.id);
        this.traces?.trace('basic', 'provider.service', 'reward paid', {
          data: { account: assignment.accountId.slice(0, 16), type: 'completion', credits: reward, assignment: assignment.id },
        });
      }
    } else {
      assignment.status = 'failed';
    }
    this.store.changed();
    this.traces?.trace('basic', 'provider.service', 'assignment finished', {
      data: { assignment: assignment.id, job: assignment.jobId, status: assignment.status, retrievals: assignment.retrievals },
    });
  }

  /** Live holders of one content across its jobs (client nodes keeping copies). */
  holdersOf(cid: string): number {
    return this.jobs()
      .filter((job) => job.cid === cid)
      .reduce((sum, job) => sum + job.holders, 0);
  }

  stats(): { jobs: number; activeAssignments: number; onlineHolders: number } {
    const active = Object.values(this.data.assignments).filter((a) => a.status === 'active');
    return {
      jobs: Object.values(this.data.jobs).filter((job) => job.status === 'open').length,
      activeAssignments: active.length,
      onlineHolders: new Set(active.filter((a) => this.isOnline(a.accountId)).map((a) => a.accountId)).size,
    };
  }

  /** Chunks the service still needs the provider to keep (jobs that are open or have live assignments). */
  pinnedChunks(): Set<string> {
    const pinned = new Set<string>();
    for (const job of Object.values(this.data.jobs)) {
      if (job.status === 'open' || this.liveAssignments(job.id).length) for (const id of job.chunkIds) pinned.add(id);
    }
    return pinned;
  }

  /**
   * Records when a job's endpoints were last tested. `jobs()` hands out copies, so this
   * must write the stored record — otherwise the dashboard keeps saying "never".
   */
  markEndpointTested(jobIds: string[], at = Date.now()): void {
    for (const id of jobIds) {
      const job = this.data.jobs[id];
      if (job) job.lastEndpointTestAt = at;
    }
    this.store.changed();
  }

  flush(): void {
    this.store.flush();
  }
}
