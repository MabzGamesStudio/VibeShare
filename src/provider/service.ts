import { randomBytes } from 'node:crypto';
import { randomId, sha256hex } from '../shared/crypto.js';
import { chunkIdOf } from '../shared/content.js';
import { badRequest, forbidden, HttpError, notFound } from '../shared/http.js';
import { log } from '../shared/log.js';
import type {
  StorageAssignment,
  StorageOffer,
  StorageRewards,
  StorageTask,
} from '../shared/protocol.js';
import { JsonFile } from '../shared/store.js';
import type { Account, Ledger } from '../commerce/ledger.js';

export interface StorageServiceConfig {
  enabled: boolean;
  /** Seconds between proof-of-storage challenges per assignment. */
  challengeIntervalSeconds: number;
  /** Share of challenges an assignment must pass to earn the completion reward. */
  minPassRatio: number;
  /** A client that has not polled for this long counts as offline (its challenges fail). */
  offlineGraceSeconds: number;
  /** Seconds a client gets to answer a task. */
  taskTimeoutSeconds: number;
  /** Create a storage job for every new upload. */
  auto: {
    enabled: boolean;
    replicas: number;
    durationDays: number;
    rewards: StorageRewards;
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
  status: 'open' | 'closed';
}

interface Assignment extends StorageAssignment {
  accountId: string;
  upfrontPaid: boolean;
  lastChallengeAt?: number;
}

interface ServiceData {
  jobs: Record<string, StorageJob>;
  assignments: Record<string, Assignment>;
}

interface PendingTask extends StorageTask {
  accountId: string;
  delivered: boolean;
  expected?: string;
  /** For retrievals the provider is waiting on. */
  waiters: ((data: Buffer | null) => void)[];
}

const LIVE: Assignment['status'][] = ['downloading', 'active'];

/**
 * Client nodes can earn credits by storing data for this provider. The provider
 * publishes jobs (what to store, for how long, for which rewards); clients accept
 * them, download the chunks, and keep a long-poll open through which the provider
 * sends tasks: retrieve a chunk (paid per retrieval) or prove it is still stored
 * (paid per challenge). The long poll goes out from the client, so it works
 * behind NAT and firewalls.
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
    private readonly readChunk: (id: string, options?: { peers?: boolean }) => Promise<Buffer | null>
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
  }): StorageJob {
    if (!input.chunks.length) throw badRequest('A job needs at least one chunk');
    const unique = new Map(input.chunks.map((chunk) => [chunk.id, chunk.size]));
    const job: StorageJob = {
      id: randomId('job-', 8),
      cid: input.cid,
      title: input.title,
      chunkIds: [...unique.keys()],
      bytes: [...unique.values()].reduce((sum, size) => sum + size, 0),
      replicas: Math.max(1, Math.floor(input.replicas ?? 2)),
      durationSeconds: Math.max(60, Math.floor(input.durationSeconds ?? 30 * 86400)),
      rewards: { upfront: 0, perRetrieval: 1, perChallenge: 1, completion: 10, ...input.rewards },
      requireIdentity: input.requireIdentity ?? false,
      createdAt: new Date().toISOString(),
      openUntil: input.openUntil,
      status: 'open',
    };
    this.data.jobs[job.id] = job;
    this.store.changed();
    return job;
  }

  closeJob(id: string): void {
    const job = this.data.jobs[id];
    if (!job) throw notFound('No such job');
    job.status = 'closed';
    this.store.changed();
  }

  jobs(): (StorageJob & { holders: number; assignments: number })[] {
    return Object.values(this.data.jobs)
      .map((job) => ({
        ...job,
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
    const mine = new Set(
      Object.values(this.data.assignments)
        .filter((a) => a.accountId === account.id && LIVE.includes(a.status))
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

  accept(account: Account, jobId: string): StorageAssignment {
    if (!this.config().enabled) throw forbidden('The storage service is turned off');
    const job = this.data.jobs[jobId];
    if (!job || !this.isOpen(job)) throw notFound('No such open job');
    if (job.requireIdentity && account.kind !== 'key') throw forbidden('This job needs a key-based account');
    if (this.liveAssignments(job.id).length >= job.replicas) throw new HttpError(409, 'full', 'The job has no free slots');
    if (this.liveAssignments(job.id).some((a) => a.accountId === account.id)) {
      throw new HttpError(409, 'duplicate', 'You already store this job');
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
      challenges: { passed: 0, failed: 0 },
      retrievals: 0,
      earned: 0,
      upfrontPaid: false,
    };
    this.data.assignments[assignment.id] = assignment;
    this.store.changed();
    return this.view(assignment);
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
    // The first challenge comes right away; the upfront reward is paid once it passes.
    void this.challenge(assignment);
    return this.view(assignment);
  }

  release(account: Account, assignmentId: string): StorageAssignment {
    const assignment = this.own(account, assignmentId);
    if (LIVE.includes(assignment.status)) {
      assignment.status = 'released';
      this.store.changed();
    }
    return this.view(assignment);
  }

  mine(account: Account): StorageAssignment[] {
    return Object.values(this.data.assignments)
      .filter((a) => a.accountId === account.id)
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))
      .slice(0, 200)
      .map((a) => this.view(a));
  }

  private view(assignment: Assignment): StorageAssignment {
    const { accountId: _account, upfrontPaid: _paid, lastChallengeAt: _last, ...rest } = assignment;
    return rest;
  }

  /** Long poll: returns undelivered tasks, waiting up to `waitSeconds` for one. */
  async poll(account: Account, waitSeconds: number): Promise<StorageTask[]> {
    this.lastPoll.set(account.id, Date.now());
    const take = () => {
      const out: StorageTask[] = [];
      for (const task of this.tasks.values()) {
        if (task.accountId !== account.id || task.delivered) continue;
        task.delivered = true;
        out.push({ id: task.id, type: task.type, assignmentId: task.assignmentId, chunkId: task.chunkId, nonce: task.nonce, deadline: task.deadline });
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

  /** The client answers a task: chunk bytes for a retrieval, or a proof for a challenge. */
  async answer(account: Account, taskId: string, body: Buffer): Promise<{ credited: number }> {
    const task = this.tasks.get(taskId);
    if (!task || task.accountId !== account.id) throw notFound('No such task (it may have timed out)');
    const assignment = this.data.assignments[task.assignmentId];
    this.tasks.delete(taskId);
    if (!assignment) return { credited: 0 };
    const job = this.data.jobs[assignment.jobId];
    let credited = 0;
    let ok: boolean;
    if (task.type === 'retrieve' || !task.expected) {
      ok = chunkIdOf(body) === task.chunkId;
      for (const waiter of task.waiters) waiter(ok ? body : null);
      if (ok && task.type === 'retrieve') {
        assignment.retrievals++;
        credited += job?.rewards.perRetrieval ?? 0;
      }
    } else {
      ok = body.toString('utf8').trim() === task.expected;
    }
    if (task.type === 'challenge') {
      if (ok) {
        assignment.challenges.passed++;
        credited += job?.rewards.perChallenge ?? 0;
        if (!assignment.upfrontPaid) {
          assignment.upfrontPaid = true;
          credited += job?.rewards.upfront ?? 0;
        }
      } else {
        assignment.challenges.failed++;
      }
    }
    if (credited > 0) {
      assignment.earned += credited;
      this.ledger.credit(account.id, credited, `storage ${task.type}`, assignment.id);
    }
    this.store.changed();
    if (!ok) throw badRequest(task.type === 'retrieve' ? 'The bytes do not match the chunk' : 'Wrong proof');
    return { credited };
  }

  private async challenge(assignment: Assignment): Promise<void> {
    const chunkId = assignment.chunkIds[Math.floor(Math.random() * assignment.chunkIds.length)];
    assignment.lastChallengeAt = Date.now();
    const nonce = randomBytes(16).toString('hex');
    // Never from client storage: that would ask the holders to answer their own challenge.
    const own = await this.readChunk(chunkId, { peers: false }).catch(() => null);
    // With its own copy the provider asks for a proof; without one it asks for the chunk itself.
    const expected = own ? sha256hex(Buffer.concat([Buffer.from(nonce), own])) : undefined;
    this.addTask({ type: 'challenge', assignmentId: assignment.id, accountId: assignment.accountId, chunkId, nonce: expected ? nonce : undefined, expected });
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
    if (!holders.length) return null;
    const chosen = holders.sort(() => Math.random() - 0.5).slice(0, 2);
    return new Promise<Buffer | null>((resolve) => {
      let pending = chosen.length;
      let done = false;
      const settle = (data: Buffer | null) => {
        done = true;
        clearTimeout(timer);
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
    const config = this.config();
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (Date.parse(task.deadline) > now) continue;
      this.tasks.delete(id);
      for (const waiter of task.waiters) waiter(null);
      if (task.type === 'challenge') {
        const assignment = this.data.assignments[task.assignmentId];
        if (assignment) assignment.challenges.failed++;
        this.store.changed();
      }
    }
    for (const assignment of Object.values(this.data.assignments)) {
      if (!LIVE.includes(assignment.status)) continue;
      if (Date.parse(assignment.expiresAt) <= now) {
        this.finish(assignment);
        continue;
      }
      if (assignment.status !== 'active') continue;
      const due = (assignment.lastChallengeAt ?? 0) + config.challengeIntervalSeconds * 1000 <= now;
      if (!due) continue;
      const outstanding = [...this.tasks.values()].some((task) => task.assignmentId === assignment.id && task.type === 'challenge');
      if (outstanding) continue;
      if (this.isOnline(assignment.accountId)) await this.challenge(assignment);
      else {
        assignment.lastChallengeAt = now;
        assignment.challenges.failed++;
        this.store.changed();
      }
    }
  }

  private finish(assignment: Assignment): void {
    const job = this.data.jobs[assignment.jobId];
    const { passed, failed } = assignment.challenges;
    const ratio = passed + failed === 0 ? 0 : passed / (passed + failed);
    if (assignment.status === 'active' && ratio >= this.config().minPassRatio) {
      assignment.status = 'completed';
      const reward = job?.rewards.completion ?? 0;
      if (reward > 0) {
        assignment.earned += reward;
        this.ledger.credit(assignment.accountId, reward, 'storage completed', assignment.id);
      }
    } else {
      assignment.status = 'failed';
    }
    this.store.changed();
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

  flush(): void {
    this.store.flush();
  }
}
