// The client's seen-content bloom filters, one per system:
//  - selected: content the user opened (selected), kept entirely on this device;
//  - preview:  content whose preview the user has seen on screen (hide it again, or
//              just push it down among the other previews — a settings choice);
//  - search:   the same seen-content record in a size that travels inside every search
//              and explore request (and nowhere else), so nodes stop suggesting whatever
//              collides with it while it is being asked;
//  - account:  a much larger, completely separate record of the same content: never sent
//              in requests, but submitted to search nodes (by hand or by the resubmission
//              job), which keep it long term and apply it while searching.
// Every filter remembers a content by its cid and each of its links, independently.
// Browser-safe: no Node imports.
import { BloomFilter, BLOOM_EXPECTED_ITEMS, optimalHashCount, type BloomFilterData, type ContentIdentity } from '../shared/bloom.js';
import type { AccountBloomSettings, BloomFilterSettings, BloomStatus } from '../shared/clientapi.js';
import type { BloomData, ClientStoreLike } from './model.js';

export type BloomScope = 'selected' | 'preview' | 'search' | 'account';

const SETTING_OF: Record<BloomScope, 'selectedBloom' | 'previewBloom' | 'searchBloom' | 'accountBloom'> = {
  selected: 'selectedBloom',
  preview: 'previewBloom',
  search: 'searchBloom',
  account: 'accountBloom',
};

/** Which filters record what: opening content, seeing a preview, and what goes to nodes. */
export const SCOPES_OF_EVENT: Record<'selected' | 'preview', BloomScope[]> = {
  // What the nodes are told covers everything the user has seen: both what was actually
  // selected and what was only previewed, so neither is ever suggested again.
  selected: ['selected', 'search', 'account'],
  preview: ['preview', 'search', 'account'],
};

export class BloomBook {
  private filters: Partial<Record<BloomScope, BloomFilter>> = {};

  constructor(private readonly store: ClientStoreLike) {}

  private get data(): BloomData {
    const data = this.store.data.data;
    data.blooms ??= {};
    return data.blooms;
  }

  /** Forgets the in-memory filters (another profile's data was loaded). */
  reloaded(): void {
    this.filters = {};
  }

  setting(scope: BloomScope): BloomFilterSettings | AccountBloomSettings {
    return this.store.data.data.settings[SETTING_OF[scope]];
  }

  /**
   * The filter of one scope, rebuilt empty whenever the size or capacity setting changed
   * (the bits of the old shape cannot be reinterpreted as the new one).
   */
  filter(scope: BloomScope): BloomFilter {
    const setting = this.setting(scope) as BloomFilterSettings;
    const { bits, expected } = setting;
    let filter = this.filters[scope];
    if (!filter || filter.m !== bits || filter.expected !== expected) {
      const saved = this.data[scope] ?? (scope === 'search' ? this.data.node : undefined);
      filter = saved && saved.m === bits && (saved.n ?? BLOOM_EXPECTED_ITEMS) === expected ? BloomFilter.from(saved) : new BloomFilter(bits, expected);
      this.filters[scope] = filter;
    }
    return filter;
  }

  private save(scope: BloomScope): void {
    this.data[scope] = this.filter(scope).toJSON();
    this.store.changed();
  }

  /** Records one content in the given filters (only those that are on). Keys added anywhere. */
  mark(input: ContentIdentity, scopes: BloomScope[]): number {
    // History paused: viewing content must not touch any filter until it is unpaused.
    if (this.store.data.data.settings.pauseHistory) return 0;
    let newKeys = 0;
    for (const scope of scopes) {
      if (!(this.setting(scope) as BloomFilterSettings).enabled) continue;
      newKeys += this.filter(scope).addContent(input);
      this.save(scope);
    }
    return newKeys;
  }

  /** Forgets everything one filter recorded and starts it over at its current size. */
  reset(scope: BloomScope): void {
    delete this.data[scope];
    this.filters[scope] = undefined;
    this.store.changed();
  }

  /** Whether the content collides with one filter (false while that filter is off). */
  sees(scope: BloomScope, input: ContentIdentity): boolean {
    return (this.setting(scope) as BloomFilterSettings).enabled && this.filter(scope).seesContent(input);
  }

  /** The bits of one filter for a search request, when its size fits the node's limit. */
  payload(scope: BloomScope, maxBits: number): BloomFilterData | null {
    const filter = this.filter(scope);
    return filter.m <= maxBits ? filter.toJSON() : null;
  }

  status(): BloomStatus {
    const of = (scope: BloomScope) => {
      const setting = this.setting(scope) as BloomFilterSettings;
      const filter = this.filter(scope);
      return {
        enabled: setting.enabled,
        bits: filter.m,
        expected: filter.expected,
        hashes: optimalHashCount(filter.m, filter.expected),
        bytes: filter.bytes,
        added: filter.added,
      };
    };
    return {
      selected: of('selected'),
      preview: of('preview'),
      search: of('search'),
      account: { ...of('account'), resubmitHours: this.store.data.data.settings.accountBloom.resubmitHours },
    };
  }
}
