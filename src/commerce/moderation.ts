// Operator moderation: bans, temporary bans and rate limits for accounts, IP addresses
// and node peers. Every node keeps its own list and shares it with its peers when they
// sync, so one operator's ban reaches the rest of the network.
import { randomId } from '../shared/crypto.js';
import { forbidden, HttpError } from '../shared/http.js';
import { JsonFile } from '../shared/store.js';

export type ModerationAction = 'permaban' | 'tempban' | 'ratelimit';
export type ModerationSubject = 'account' | 'ip' | 'peer';

export interface ModerationEntry {
  id: string;
  /** What kind of target this is: an account id, an IP address, or a peer node id. */
  subject: ModerationSubject;
  /** The account id, IP address, or peer node id being moderated. */
  target: string;
  action: ModerationAction;
  /** `tempban`: when it ends (ISO). */
  until?: string;
  /** `ratelimit`: how many requests per minute the target may still make. */
  perMinute?: number;
  reason?: string;
  createdAt: string;
  /** `operator`, or the node id a shared entry came from. */
  by: string;
}

interface ModerationData {
  entries: ModerationEntry[];
}

/** Who a request is coming from, as far as moderation is concerned. */
export interface ModerationSubjectSet {
  ip?: string;
  /** The account behind the bearer token, when there is one (a peer is one too). */
  account?: string;
}

const RATELIMIT_WINDOW_MS = 60_000;

export class Moderation {
  private store: JsonFile<ModerationData>;
  /** One-minute request windows per rate-limited target. */
  private hits = new Map<string, number[]>();

  constructor(path: string | null) {
    this.store = new JsonFile<ModerationData>(path, () => ({ entries: [] }));
    this.prune();
  }

  /** Temporary bans whose time ran out are gone for good. */
  private prune(): void {
    const before = this.store.data.entries.length;
    this.store.data.entries = this.store.data.entries.filter((entry) => !this.expired(entry));
    if (this.store.data.entries.length !== before) this.store.changed();
  }

  private expired(entry: ModerationEntry): boolean {
    return entry.action === 'tempban' && !!entry.until && entry.until <= new Date().toISOString();
  }

  list(): ModerationEntry[] {
    this.prune();
    return [...this.store.data.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ModerationEntry | undefined {
    return this.store.data.entries.find((entry) => entry.id === id);
  }

  add(input: {
    subject: ModerationSubject;
    target: string;
    action: ModerationAction;
    until?: string;
    perMinute?: number;
    reason?: string;
    by?: string;
  }): ModerationEntry {
    if (!['account', 'ip', 'peer'].includes(input.subject)) throw new HttpError(400, 'bad_request', 'subject is account, ip or peer');
    if (!['permaban', 'tempban', 'ratelimit'].includes(input.action)) throw new HttpError(400, 'bad_request', 'action is permaban, tempban or ratelimit');
    const target = String(input.target ?? '').trim();
    if (!target) throw new HttpError(400, 'bad_request', 'target is required');
    // One entry per target and action: adding again replaces (the newest word wins).
    this.store.data.entries = this.store.data.entries.filter(
      (entry) => !(entry.subject === input.subject && entry.target === target && entry.action === input.action)
    );
    const entry: ModerationEntry = {
      id: randomId('mod-', 10),
      subject: input.subject,
      target,
      action: input.action,
      ...(input.action === 'tempban' ? { until: input.until ?? new Date(Date.now() + 24 * 3600_000).toISOString() } : {}),
      ...(input.action === 'ratelimit' ? { perMinute: Math.max(1, Math.round(input.perMinute ?? 30)) } : {}),
      reason: String(input.reason ?? '').slice(0, 300) || undefined,
      createdAt: new Date().toISOString(),
      by: input.by ?? 'operator',
    };
    this.store.data.entries.push(entry);
    this.store.changed();
    return entry;
  }

  remove(id: string): boolean {
    const before = this.store.data.entries.length;
    this.store.data.entries = this.store.data.entries.filter((entry) => entry.id !== id);
    if (this.store.data.entries.length !== before) {
      this.store.changed();
      return true;
    }
    return false;
  }

  /** Every entry that matches one of the subjects a request carries. */
  private matches(subject: ModerationSubjectSet): ModerationEntry[] {
    return this.list().filter((entry) => (entry.subject === 'ip' ? entry.target === subject.ip : entry.target === subject.account));
  }

  /**
   * The gate every request goes through: a banned account, IP or peer is turned away at
   * once; a rate-limited one is turned away only once it goes over its per-minute pace.
   */
  enforce(subject: ModerationSubjectSet): void {
    const entries = this.matches(subject);
    for (const entry of entries) {
      if (entry.action === 'permaban') throw forbidden(entry.reason ? `Banned: ${entry.reason}` : 'Banned from this node');
      if (entry.action === 'tempban') throw forbidden(entry.reason ? `Suspended: ${entry.reason}` : 'Suspended from this node');
    }
    for (const entry of entries) {
      if (entry.action !== 'ratelimit') continue;
      const key = `${entry.subject}:${entry.target}`;
      const now = Date.now();
      const recent = (this.hits.get(key) ?? []).filter((at) => now - at < RATELIMIT_WINDOW_MS);
      recent.push(now);
      this.hits.set(key, recent);
      if (recent.length > (entry.perMinute ?? 30)) {
        throw new HttpError(429, 'rate_limited', entry.reason ? `Slow down: ${entry.reason}` : 'Too many requests — rate limited');
      }
    }
  }

  /** What a peer receives when syncing: everything still active. */
  export(): ModerationEntry[] {
    return this.list();
  }

  /** Merges a peer's entries (the newest word on one target wins). Returns how many are new. */
  merge(entries: unknown[], from: string): number {
    let added = 0;
    for (const raw of Array.isArray(entries) ? entries : []) {
      const entry = raw as Partial<ModerationEntry>;
      if (!entry || !entry.target || !entry.action || !['account', 'ip', 'peer'].includes(String(entry.subject))) continue;
      this.add({
        subject: entry.subject as ModerationSubject,
        target: String(entry.target),
        action: entry.action as ModerationAction,
        until: entry.until,
        perMinute: entry.perMinute,
        reason: entry.reason,
        by: entry.by && entry.by !== 'operator' ? entry.by : from,
      });
      added++;
    }
    return added;
  }
}