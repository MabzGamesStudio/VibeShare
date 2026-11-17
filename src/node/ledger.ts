import { randomId } from '../shared/crypto.js';
import { paymentRequired, notFound } from '../shared/http.js';
import type { AccountView, LedgerEntry } from '../shared/protocol.js';
import { AppendLog, JsonFile } from '../shared/store.js';

export interface Account {
  id: string;
  kind: 'anonymous' | 'key';
  /** sha256 of the bearer token of an anonymous account. */
  tokenHash?: string;
  balance: number;
  earned: number;
  spent: number;
  createdAt: string;
  lastSeen?: string;
  recent: LedgerEntry[];
  /** Per-day counters (free allowance used, rewards earned, …), reset each UTC day. */
  daily?: { day: string; counters: Record<string, number> };
  note?: string;
}

interface LedgerData {
  accounts: Record<string, Account>;
}

const RECENT_LIMIT = 100;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Credits of one node. Credits only mean something on the node that issued them:
 * every node keeps its own ledger and decides how credits are earned and spent.
 */
export class Ledger {
  private store: JsonFile<LedgerData>;
  private audit: AppendLog;
  private byTokenHash = new Map<string, string>();

  constructor(path: string | null, auditPath: string | null) {
    this.store = new JsonFile<LedgerData>(path, () => ({ accounts: {} }));
    this.audit = new AppendLog(auditPath);
    for (const account of Object.values(this.store.data.accounts)) {
      if (account.tokenHash) this.byTokenHash.set(account.tokenHash, account.id);
    }
  }

  get(id: string): Account | undefined {
    return this.store.data.accounts[id];
  }

  require(id: string): Account {
    const account = this.get(id);
    if (!account) throw notFound(`No account ${id}`);
    return account;
  }

  byToken(tokenHash: string): Account | undefined {
    const id = this.byTokenHash.get(tokenHash);
    return id ? this.get(id) : undefined;
  }

  all(): Account[] {
    return Object.values(this.store.data.accounts);
  }

  count(): number {
    return Object.keys(this.store.data.accounts).length;
  }

  create(kind: Account['kind'], options: { id?: string; tokenHash?: string; grant?: number } = {}): Account {
    const id = options.id ?? randomId('anon-', 10);
    if (this.store.data.accounts[id]) return this.store.data.accounts[id];
    const account: Account = {
      id,
      kind,
      tokenHash: options.tokenHash,
      balance: 0,
      earned: 0,
      spent: 0,
      createdAt: new Date().toISOString(),
      recent: [],
    };
    this.store.data.accounts[id] = account;
    if (options.tokenHash) this.byTokenHash.set(options.tokenHash, id);
    if (options.grant && options.grant > 0) this.credit(id, options.grant, 'signup grant');
    this.store.changed();
    return account;
  }

  touch(account: Account): void {
    const now = new Date().toISOString();
    if (!account.lastSeen || now.slice(0, 13) !== account.lastSeen.slice(0, 13)) {
      account.lastSeen = now;
      this.store.changed();
    }
  }

  private record(account: Account, amount: number, reason: string, ref?: string): LedgerEntry {
    const entry: LedgerEntry = { at: new Date().toISOString(), amount, balance: account.balance, reason, ref };
    account.recent.unshift(entry);
    if (account.recent.length > RECENT_LIMIT) account.recent.length = RECENT_LIMIT;
    this.audit.append({ account: account.id, ...entry });
    this.store.changed();
    return entry;
  }

  credit(id: string, amount: number, reason: string, ref?: string): Account {
    const account = this.require(id);
    const value = Math.floor(amount);
    if (value <= 0) return account;
    account.balance += value;
    account.earned += value;
    this.record(account, value, reason, ref);
    return account;
  }

  /** Takes credits or throws 402 Payment Required with the balance and price. */
  debit(id: string, amount: number, reason: string, ref?: string): Account {
    const account = this.require(id);
    const value = Math.ceil(amount);
    if (value <= 0) return account;
    if (account.balance < value) {
      throw paymentRequired(`Not enough credits: ${reason} costs ${value}, the balance is ${account.balance}`, {
        price: value,
        balance: account.balance,
      });
    }
    account.balance -= value;
    account.spent += value;
    this.record(account, -value, reason, ref);
    return account;
  }

  /** Moves credits between two accounts of this node (e.g. a share of a download to the creator). */
  transfer(from: string, to: string, amount: number, reason: string, ref?: string): void {
    if (from === to || amount <= 0) return;
    this.debit(from, amount, reason, ref);
    this.credit(to, amount, reason, ref);
  }

  daily(account: Account, key: string): number {
    if (account.daily?.day !== today()) return 0;
    return account.daily.counters[key] ?? 0;
  }

  addDaily(account: Account, key: string, amount: number): void {
    const day = today();
    if (account.daily?.day !== day) account.daily = { day, counters: {} };
    account.daily.counters[key] = (account.daily.counters[key] ?? 0) + amount;
    this.store.changed();
  }

  setNote(id: string, note: string): void {
    this.require(id).note = note;
    this.store.changed();
  }

  view(account: Account): AccountView {
    return {
      id: account.id,
      kind: account.kind,
      balance: account.balance,
      earned: account.earned,
      spent: account.spent,
      createdAt: account.createdAt,
    };
  }

  flush(): void {
    this.store.flush();
  }
}
