// Looking up subscribed creators on their own platforms: which adapter can be asked
// about one creator, and under which target. The crawler's refresh (crawler.ts) runs
// these lookups; this module only works out who to ask.
//
// Targeting rules: a creator id or account names a platform (`yt:UC…`, `youtube:UC…`,
// an account's `platform` — a scheme or a host) and something to look up (a channel id,
// a handle). An adapter that understands creator targets (`channel:…` — YouTube's RSS
// feeds need no key) is asked through `discover`; everything else falls back to
// `search(handle or name)`.
import { PLATFORM_KEYS } from './oembed.js';
import type { Adapter } from './types.js';

/** The platform accounts of a creator, as the registry keeps them. */
export interface CreatorAccountRef {
  platform: string;
  handle: string;
  url?: string;
}

export interface CreatorLookup {
  name?: string;
  accounts?: CreatorAccountRef[];
}

/** What a creator refresh came to: the totals once every lookup has settled. */
export interface CreatorRefreshSummary {
  /** Platform lookups that completed. */
  checked: number;
  /** New catalog entries they brought in. */
  added: number;
  /** Creators still waiting for a completed look (they come first next time). */
  pending: number;
}

/** One way to ask one adapter about one creator. */
export interface CreatorQuery {
  /** The creator id the client subscribed to — findings are tagged with it. */
  creatorId: string;
  /** The creator's display name, when known. */
  name?: string;
  adapter: Adapter;
  /** The discover() target asking for this creator's uploads, when the adapter has one. */
  target?: string;
  /** Otherwise the handle or name to search for. */
  search?: string;
}

/** The discover() target vocabulary that means "one creator's uploads". */
const CREATOR_TARGETS = ['channel', 'user', 'creator'];

/**
 * The discover() target asking an adapter about one creator, when its target
 * vocabulary has one (`channel:…` for YouTube's channel RSS). An adapter may say so
 * outright with `creatorTarget`; otherwise its own targets() vocabulary is read.
 */
export function creatorTargetOf(adapter: Adapter, config: Record<string, unknown>, value: string): string | null {
  const direct = adapter.creatorTarget?.(value);
  if (direct) return direct;
  const vocabulary = (adapter.targets?.(config as never, []) ?? []).map(String);
  for (const target of vocabulary) {
    const prefix = target.split(':')[0];
    if (CREATOR_TARGETS.includes(prefix)) return `${prefix}:${value}`;
  }
  return null;
}

/** The adapters that may be asked about a platform name (a scheme, an adapter id or a host). */
function adaptersFor(platform: string, adapters: Adapter[], url?: string): Adapter[] {
  const clean = platform.trim().toLowerCase();
  if (!clean) return [];
  const out: Adapter[] = [];
  for (const adapter of adapters) {
    if (adapter.id === clean || adapter.id === PLATFORM_KEYS[clean]) {
      out.push(adapter);
      continue;
    }
    // A host platform (the account's handle lives there): any adapter that recognizes it.
    for (const text of [`https://${clean}/`, url]) {
      if (!text) continue;
      try {
        if (adapter.match(new URL(text))) {
          out.push(adapter);
          break;
        }
      } catch {
        // not a URL: not this adapter's
      }
    }
  }
  return out;
}

/**
 * Every way the node can ask a platform about one creator: from the creator record's
 * accounts, and from the id itself when it names a platform (`yt:UC…`, `peertube:name@host`).
 * One query per creator and adapter — a discover target beats a plain search.
 */
export function creatorQueries(id: string, record: CreatorLookup | undefined, adapters: Adapter[], adapterConfig: (adapter: Adapter) => Record<string, unknown>): CreatorQuery[] {
  const candidates: { platform: string; value?: string; handle?: string; url?: string }[] = [];
  const colon = id.indexOf(':');
  if (colon > 0 && !id.startsWith('vk1') && !id.startsWith('tp1') && !id.startsWith('name:')) {
    candidates.push({ platform: id.slice(0, colon), value: id.slice(colon + 1) });
  }
  for (const account of record?.accounts ?? []) {
    candidates.push({ platform: account.platform, handle: account.handle, url: account.url });
  }
  const out: CreatorQuery[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const adapter of adaptersFor(candidate.platform, adapters, candidate.url)) {
      if (seen.has(adapter.id)) continue;
      const config = adapterConfig(adapter);
      const target = candidate.value ? creatorTargetOf(adapter, config, candidate.value) : null;
      const search = candidate.handle ?? record?.name ?? candidate.value;
      if ((!target || !adapter.discover) && (!search || !adapter.search)) continue;
      seen.add(adapter.id);
      out.push({
        creatorId: id,
        name: record?.name,
        adapter,
        target: target && adapter.discover ? target : undefined,
        search: target && adapter.discover ? undefined : search,
      });
    }
  }
  return out;
}

/** Runs tasks over a list, `limit` at a time; one failing task never stops the rest. */
export async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  });
  await Promise.all(workers);
}