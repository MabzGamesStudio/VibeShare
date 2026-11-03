// Content storage tiers: where each piece of content lives and for how long. The
// operator defines as many tiers as they want (bronze, silver, gold by default); each
// says how many copies sit on which storage medium (HDD, SSD, or any medium the operator
// adds) and how many external user URL backups it wants. New uploads land in the default
// tier; users pay credits to raise a content's tier or extend its lifecycle, and expired
// assignments downgrade (or are forgotten) on the node's schedule. URL backups never come
// from the same domain twice unless there is no other choice or the operator overrides it.
import { JsonFile } from '../shared/store.js';
import type { Ledger } from '../commerce/ledger.js';

/** One storage medium a tier can place copies on; `backends` are the store's backend ids. */
export interface TierMedium {
  id: string;
  label: string;
  /** Store backend ids whose bytes count as this medium (empty = the node's defaults). */
  backends: string[];
}

/**
 * The storage job a tier opens for its content: what it pays and how often it is
 * checked. Retrieval and challenge pay per MiB of the content, so big jobs pay more.
 */
export interface TierJobSettings {
  upfrontCredits: number;
  perMbRetrieval: number;
  perMbChallenge: number;
  endOfTerm: number;
  /** Endpoints slower than this count as failed checks. */
  maxLatencyMs: number;
  challengeEveryMinutes: number;
  /** 0 = no periodic retrieval tests. */
  retrievalTestEveryMinutes: number;
  /** Consecutive failed requests before an endpoint counts as failed. */
  failedRequestsBeforeFailure: number;
}

export function defaultTierJobSettings(): TierJobSettings {
  return {
    upfrontCredits: 20,
    perMbRetrieval: 5,
    perMbChallenge: 1,
    endOfTerm: 20,
    maxLatencyMs: 2000,
    challengeEveryMinutes: 10,
    retrievalTestEveryMinutes: 60,
    failedRequestsBeforeFailure: 3,
  };
}

/** One tier: the copy plan, its price and its lifecycle. */
export interface TierConfig {
  id: string;
  label: string;
  /** Copies to keep per medium id, e.g. { hdd: 1, ssd: 1 }. */
  media: Record<string, number>;
  /** External user URL backups wanted (distinct domains are preferred). */
  externalUrls: number;
  /** Credits per MiB a user pays to request this tier for a piece of content. */
  pricePerMiB: number;
  /** How long an assignment lasts before it downgrades, in days (0 = forever). */
  lifecycleDays: number;
  /** Where expired assignments go (null = completely forgotten). */
  downgradeTo: string | null;
  /** The storage job this tier opens for its content. */
  job?: TierJobSettings;
}

export interface TiersConfig {
  enabled: boolean;
  /** Assign the default tier to every new upload automatically. */
  auto: boolean;
  defaultTier: string;
  media: TierMedium[];
  tiers: TierConfig[];
}

/** What the node keeps about one content's tier. */
export interface TierAssignment {
  cid: string;
  title?: string;
  tier: string;
  bytes: number;
  assignedAt: string;
  /** When the lifecycle ends and the tier downgrades (undefined = no expiry). */
  expiresAt?: string;
  /** Set when a user or the operator chose the tier by hand — never auto-changed. */
  manual?: boolean;
  /** Accepted external URL backups, by URL. */
  urls: Record<string, string>;
}

/** The answer to a tier query: everything a viewer needs to see and upgrade. */
export interface TierState {
  cid: string;
  tier: string;
  label: string;
  assignedAt: string;
  expiresAt?: string;
  daysLeft?: number;
  manual?: boolean;
  plan: { media: Record<string, number>; externalUrls: number; job?: TierJobSettings };
  backups: { urls: number; domains: string[]; satisfied: boolean; note?: string };
  /** The tiers this content can be raised to, with the price for its size. */
  upgrades: { id: string; label: string; price: number; lifecycleDays: number; downgradeTo: string | null }[];
}

interface TierData {
  assignments: Record<string, TierAssignment>;
}

/** The operator's starting tiers: two URL backups, then +HDD, then +SSD and a third URL. */
export function defaultTiersConfig(): TiersConfig {
  return {
    enabled: true,
    auto: true,
    defaultTier: 'bronze',
    media: [
      { id: 'hdd', label: 'HDD', backends: [] },
      { id: 'ssd', label: 'SSD', backends: [] },
    ],
    tiers: [
      { id: 'bronze', label: 'Bronze', media: {}, externalUrls: 2, pricePerMiB: 0, lifecycleDays: 90, downgradeTo: null, job: defaultTierJobSettings() },
      { id: 'silver', label: 'Silver', media: { hdd: 1 }, externalUrls: 2, pricePerMiB: 1, lifecycleDays: 180, downgradeTo: 'bronze', job: defaultTierJobSettings() },
      { id: 'gold', label: 'Gold', media: { hdd: 1, ssd: 1 }, externalUrls: 3, pricePerMiB: 3, lifecycleDays: 365, downgradeTo: 'silver', job: defaultTierJobSettings() },
    ],
  };
}

/** The job settings of one tier, with defaults for tiers saved before they existed. */
export function tierJob(tier: { job?: TierJobSettings } | undefined): TierJobSettings {
  return { ...defaultTierJobSettings(), ...(tier?.job ?? {}) };
}

const MiB = 1024 * 1024;

/**
 * Fills a tiers config that has no tiers left (an old or hand-edited config) with the
 * stock plan — content must always have something to be assigned to.
 */
export function withDefaultTiers(settings: TiersConfig): TiersConfig {
  if (settings.tiers?.length) return settings;
  const defaults = defaultTiersConfig();
  return { ...settings, tiers: defaults.tiers, defaultTier: settings.defaultTier || defaults.defaultTier };
}

export class TierManager {
  private store: JsonFile<TierData>;

  constructor(
    path: string | null,
    private readonly config: () => TiersConfig,
    private readonly ledger: Ledger,
    private readonly hooks: {
      /** Frees the local bytes of a content (its manifest and index survive). */
      releaseBytes?: (cid: string) => Promise<unknown>;
      /** Deletes a content from memory entirely (bytes, manifest and index). */
      deleteContent?: (cid: string) => Promise<unknown>;
      /** Live storage-service holders of one content (client nodes keeping copies). */
      holders?: (cid: string) => number;
      /** Size of one content, so an assignment priced per MiB can be charged from scratch. */
      bytesOf?: (cid: string) => number;
      /** The content landed on a new tier (or changed tier) — its storage job follows. */
      onChanged?: (cid: string) => void;
    } = {}
  ) {
    this.store = new JsonFile<TierData>(path, () => ({ assignments: {} }));
  }

  tier(id: string): TierConfig | undefined {
    return this.config().tiers.find((tier) => tier.id === id);
  }

  private expiryFor(tier: TierConfig, from = Date.now()): string | undefined {
    return tier.lifecycleDays > 0 ? new Date(from + tier.lifecycleDays * 86_400_000).toISOString() : undefined;
  }

  /** Assigns the default tier to a new upload (or refreshes an existing assignment). */
  assign(cid: string, bytes: number, title?: string): TierAssignment | undefined {
    const settings = this.config();
    if (!settings.enabled) return undefined;
    return this.ensure(cid, bytes, title);
  }

  /**
   * Creates (or refreshes) an assignment on demand — works even with the tier system
   * switched off or no tiers configured yet, so a tier can always be set.
   */
  ensure(cid: string, bytes: number, title?: string, tierId?: string): TierAssignment {
    const settings = this.config();
    const tier = (tierId ? this.tier(tierId) : undefined) ?? this.tier(settings.defaultTier) ?? settings.tiers[0];
    const existing = this.store.data.assignments[cid];
    const assignment: TierAssignment = existing ?? {
      cid,
      tier: tier?.id ?? tierId ?? 'default',
      bytes,
      assignedAt: new Date().toISOString(),
      urls: {},
    };
    if (bytes > 0) assignment.bytes = bytes;
    if (title) assignment.title = title;
    if (!existing && tier) assignment.expiresAt = this.expiryFor(tier);
    this.store.data.assignments[cid] = assignment;
    this.store.changed();
    if (!existing) this.hooks.onChanged?.(cid);
    return assignment;
  }

  /** Everything about one content's tier and lifecycle, with its upgrade prices. */
  stateOf(cid: string): TierState | undefined {
    const assignment = this.store.data.assignments[cid];
    if (!assignment) return undefined;
    return this.describe(assignment);
  }

  /**
   * The upgrade menu for content not assigned yet: any user can buy its first tier with
   * credits, priced by the content's size.
   */
  preview(cid: string, bytes: number): TierState {
    const settings = this.config();
    const tier = this.tier(settings.defaultTier) ?? settings.tiers[0];
    return {
      cid,
      tier: '',
      label: 'Not assigned yet',
      assignedAt: '',
      plan: { media: tier?.media ?? {}, externalUrls: tier?.externalUrls ?? 0, job: tierJob(tier) },
      backups: { urls: 0, domains: [], satisfied: false },
      upgrades: (settings.tiers ?? []).map((entry) => ({
        id: entry.id,
        label: entry.label,
        price: this.priceFor(entry.id, bytes),
        lifecycleDays: entry.lifecycleDays,
        downgradeTo: entry.downgradeTo,
      })),
    };
  }

  /** Every assignment (for the operator's dashboard). */
  assignments(): TierAssignment[] {
    return Object.values(this.store.data.assignments);
  }

  private describe(assignment: TierAssignment): TierState {
    const tier = this.tier(assignment.tier);
    const settings = this.config();
    const { counted, domains, satisfied } = this.backupCount(assignment.cid);
    return {
      cid: assignment.cid,
      tier: assignment.tier,
      label: tier?.label ?? assignment.tier,
      assignedAt: assignment.assignedAt,
      expiresAt: assignment.expiresAt,
      daysLeft: assignment.expiresAt ? Math.max(0, Math.round((Date.parse(assignment.expiresAt) - Date.now()) / 86_400_000)) : undefined,
      manual: assignment.manual,
      plan: { media: tier?.media ?? {}, externalUrls: tier?.externalUrls ?? 0, job: tierJob(tier) },
      backups: {
        urls: counted,
        domains,
        satisfied,
        note: counted < Object.keys(assignment.urls).length ? 'Multiple backups share one domain — counted as one until other domains are filled.' : undefined,
      },
      upgrades: settings.tiers.map((entry) => ({
        id: entry.id,
        label: entry.label,
        price: this.priceFor(entry.id, assignment.bytes),
        lifecycleDays: entry.lifecycleDays,
        downgradeTo: entry.downgradeTo,
      })),
    };
  }

  /** Sets a content's tier by hand (the operator, or a user through chargeTier). */
  setTier(cid: string, tierId: string, options: { manual?: boolean; keepExpiry?: boolean } = {}): TierAssignment {
    const assignment = this.store.data.assignments[cid] ?? {
      cid,
      tier: tierId,
      bytes: this.hooks.bytesOf?.(cid) ?? 0,
      assignedAt: new Date().toISOString(),
      urls: {},
    };
    const tier = this.tier(tierId);
    assignment.tier = tierId;
    if (options.manual) assignment.manual = true;
    if (!options.keepExpiry && tier) assignment.expiresAt = this.expiryFor(tier);
    this.store.data.assignments[cid] = assignment;
    this.store.changed();
    this.hooks.onChanged?.(cid);
    return assignment;
  }

  /** Pushes a content's lifecycle further out (or starts the clock again). */
  extend(cid: string, days: number): TierAssignment | undefined {
    const assignment = this.store.data.assignments[cid];
    if (!assignment) return undefined;
    const from = Math.max(Date.now(), assignment.expiresAt ? Date.parse(assignment.expiresAt) : Date.now());
    assignment.expiresAt = new Date(from + days * 86_400_000).toISOString();
    this.store.changed();
    return assignment;
  }

  /**
   * A user raises the tier and/or extends the lifecycle of any content, paying the
   * listed credits. Returns what it cost and the new state.
   */
  chargeTier(account: string, cid: string, body: { tier?: string; extendDays?: number }): { charged: number; state: TierState } {
    // Content not assigned yet can be bought onto a tier straight away — this creates
    // the assignment even with the tier system switched off, so it always works.
    const assignment = this.store.data.assignments[cid] ?? this.ensure(cid, this.hooks.bytesOf?.(cid) ?? 0);
    let charged = 0;
    if (body.tier && body.tier !== assignment.tier) {
      const price = this.priceFor(body.tier, assignment.bytes);
      if (price > 0) this.ledger.debit(account, price, 'tier upgrade', cid);
      charged += price;
      this.setTier(cid, body.tier, { manual: true });
    }
    if (body.extendDays && body.extendDays > 0) {
      const price = Math.max(1, Math.ceil((body.extendDays / 30) * this.priceFor(assignment.tier, assignment.bytes)));
      this.ledger.debit(account, price, 'tier extension', cid);
      charged += price;
      this.extend(cid, body.extendDays);
    }
    return { charged, state: this.stateOf(cid)! };
  }

  /** Records an accepted external URL backup (the domain rule applies when counting). */
  recordUrl(cid: string, url: string): void {
    // Only content on a tier tracks backups — unassigned content keeps nothing here.
    const assignment = this.store.data.assignments[cid];
    if (!assignment) return;
    assignment.urls[url] = new Date().toISOString();
    this.store.changed();
    void this.maybeRelease(cid);
  }

  /**
   * The domain rule for external backups: one backup per domain counts first, extras on
   * the same domain only after every domain is used up — the operator can still accept
   * duplicates by hand (they live in the record, just counted last).
   */
  backupCount(cid: string): { counted: number; domains: string[]; satisfied: boolean } {
    const assignment = this.store.data.assignments[cid];
    if (!assignment) return { counted: 0, domains: [], satisfied: false };
    const domains = [...new Set(Object.keys(assignment.urls).map((url) => domainOf(url)).filter(Boolean))] as string[];
    const urls = Object.keys(assignment.urls).length;
    const want = this.tier(assignment.tier)?.externalUrls ?? 0;
    const counted = want > 0 && domains.length < want ? urls : Math.max(domains.length, Math.min(urls, want));
    return { counted, domains, satisfied: want > 0 && counted >= want };
  }

  /** Bronze-style content (no local copies) frees its bytes once a user job takes it up. */
  private async maybeRelease(cid: string): Promise<void> {
    const assignment = this.store.data.assignments[cid];
    if (!assignment) return;
    const tier = this.tier(assignment.tier);
    if (!tier || !this.hooks.releaseBytes) return;
    const localCopies = Object.values(tier.media).reduce((sum, count) => sum + count, 0);
    if (localCopies > 0) return;
    const { satisfied } = this.backupCount(cid);
    const holders = this.hooks.holders?.(cid) ?? 0;
    if (satisfied || holders > 0) await this.hooks.releaseBytes(cid);
  }

  /** Lifecycles: expired assignments downgrade along their chain, or are forgotten. */
  async tick(): Promise<void> {
    const settings = this.config();
    if (!settings.enabled) return;
    const now = Date.now();
    for (const assignment of Object.values(this.store.data.assignments)) {
      if (assignment.manual || !assignment.expiresAt) continue;
      if (Date.parse(assignment.expiresAt) > now) continue;
      const tier = this.tier(assignment.tier);
      const next = tier?.downgradeTo ?? null;
      if (next && this.tier(next)) {
        this.setTier(assignment.cid, next, { keepExpiry: false });
      } else {
        // No tier below: the content is deleted from memory entirely.
        delete this.store.data.assignments[assignment.cid];
        this.store.changed();
        this.hooks.onChanged?.(assignment.cid);
        await (this.hooks.deleteContent?.(assignment.cid) ?? this.hooks.releaseBytes?.(assignment.cid));
      }
    }
  }

  /** Removes an assignment by hand — the content is deleted from memory with it. */
  async forget(cid: string): Promise<boolean> {
    if (!this.store.data.assignments[cid]) return false;
    delete this.store.data.assignments[cid];
    this.store.changed();
    this.hooks.onChanged?.(cid); // the content's storage job goes with it
    await (this.hooks.deleteContent?.(cid) ?? this.hooks.releaseBytes?.(cid));
    return true;
  }

  /** Credits a user pays to put one content on a tier. */
  priceFor(tierId: string, bytes: number): number {
    const tier = this.tier(tierId);
    if (!tier) return 0;
    return Math.ceil((bytes / MiB) * Math.max(0, tier.pricePerMiB));
  }
}

/** The domain of a backup URL — two backups on one domain count as one. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}