// Bloom filters of content the user has seen: its cid and its links, hashed into a bit
// array. The client keeps them locally (selected content, previewed content) and may send
// the bits to search algorithm nodes (who then stop suggesting what collides).
// Browser-safe: no Node imports — hashes come from shared/crypto (the web build swaps in
// its browser twin, so the bits are identical on both sides).
import { sha256 } from './crypto.js';
import { base64url, fromBase64url } from './encoding.js';
import { formatSource, parseContentId } from './sources.js';

/**
 * The number of items every filter is designed to hold unless the settings say otherwise.
 * The optimal number of hash functions for `m` bits and this capacity is k = (m/n)·ln 2 —
 * with n = 10,000, k grows with the chosen size (1 bit → 1 hash, 100,000 bits → 7,
 * 100,000,000 bits → 6,931).
 */
export const BLOOM_EXPECTED_ITEMS = 10_000;

/** How many items one filter may be designed for at the most (the settings cap). */
export const BLOOM_EXPECTED_MAX = 10_000_000;

/** The wire/saved form of one filter. `data` is base64url of ceil(m/8) bytes. */
export interface BloomFilterData {
  v: 1;
  /** Number of bits. */
  m: number;
  /** Number of hash functions. */
  k: number;
  /** Number of items the filter is made for (its design capacity; defaults to 10,000). */
  n?: number;
  /** How many keys were added so far (informational; nodes ignore it). */
  added?: number;
  /** base64url of the bit array. */
  data: string;
}

/** The optimal hash count for `m` bits and `expected` items: k = (m/n)·ln 2 (at least 1). */
export function optimalHashCount(m: number, expected = BLOOM_EXPECTED_ITEMS): number {
  return Math.max(1, Math.round((m / expected) * Math.LN2));
}

/** What one content is remembered by: its cid and each separate link, all independently. */
export interface ContentIdentity {
  /** The full content id (`vs1…~yt:…`), as shown to the user. */
  id?: string;
  /** The VibeShare content id (`vs1…`), when there is one. */
  contentId?: string;
  /** Where the content lives outside the network, when there is no content id. */
  link?: string;
  /** Fallback sources carried with the id (already formatted, `yt:…`). */
  sources?: string[];
}

/**
 * The keys of one content: its cid and each separate link. Every key is added to (and
 * checked against) the filter on its own — one content may be remembered by its cid, by
 * its platform link, or by any other link it carries.
 */
export function contentKeys(input: ContentIdentity): string[] {
  const keys: string[] = [];
  const add = (key: string | undefined) => {
    const clean = String(key ?? '').trim();
    if (clean && !keys.includes(clean)) keys.push(clean);
  };
  const parsed = input.id ? parseContentId(input.id) : null;
  const nativeId = parsed?.native ? parsed.base : undefined;
  add(input.contentId ?? nativeId);
  add(input.link);
  for (const source of parsed?.sources ?? []) add(formatSource(source));
  for (const source of input.sources ?? []) add(source);
  // An external id (`yt:…`, `url:…`) is itself the link of the content.
  if (parsed && !parsed.native) add(parsed.base);
  return keys;
}

/**
 * A bloom filter over the keys of seen content (see contentKeys). The bit array is a
 * fixed `m` bits; `k` double-hashed indexes are set per key (h1 + i·h2 mod m), the
 * standard way to spend the optimal number of hash functions without hashing k times.
 */
export class BloomFilter {
  readonly bits: Uint8Array;
  /** How many keys were added (the filter is designed for `expected` of them). */
  added = 0;
  /** Bumped on every change, so the serialized form can be cached. */
  version = 0;
  private cached?: { version: number; json: BloomFilterData };

  constructor(
    readonly m: number,
    /** How many items the filter is made for (its design capacity). */
    readonly expected: number = BLOOM_EXPECTED_ITEMS,
    readonly k: number = optimalHashCount(m, expected),
    bits?: Uint8Array
  ) {
    if (!Number.isInteger(m) || m < 1) throw new Error('A bloom filter needs at least one bit');
    if (!Number.isInteger(expected) || expected < 1) throw new Error('A bloom filter is made for at least one item');
    if (!Number.isInteger(k) || k < 1) throw new Error('A bloom filter needs at least one hash');
    this.bits = bits ?? new Uint8Array(Math.ceil(m / 8));
    if (this.bits.length !== Math.ceil(m / 8)) throw new Error('The bit array does not match the size');
  }

  /** Rebuilds a filter from its saved or sent form. */
  static from(data: BloomFilterData): BloomFilter {
    const expected = Math.max(1, Math.floor(Number(data.n ?? BLOOM_EXPECTED_ITEMS)));
    const filter = new BloomFilter(data.m, expected, data.k, Uint8Array.from(fromBase64url(data.data)));
    filter.added = Math.max(0, Math.floor(Number(data.added ?? 0)));
    return filter;
  }

  /** The saved or sent form of this filter (cached until the next add). */
  toJSON(): BloomFilterData {
    if (this.cached && this.cached.version === this.version) return this.cached.json;
    const json: BloomFilterData = { v: 1, m: this.m, k: this.k, n: this.expected, added: this.added, data: base64url(this.bits) };
    this.cached = { version: this.version, json };
    return json;
  }

  /** Bytes of the bit array (ceil(m/8)); what a copy costs to store or send. */
  get bytes(): number {
    return this.bits.length;
  }

  private indexes(key: string): number[] {
    const digest = sha256(key);
    const u32 = (offset: number) => ((digest[offset] << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) >>> 0;
    const h1 = u32(0);
    const h2 = (u32(4) | 1) >>> 0;
    const out: number[] = [];
    for (let i = 0; i < this.k; i++) out.push((h1 + i * h2) % this.m);
    return out;
  }

  add(key: string): void {
    for (const index of this.indexes(key)) {
      const byte = index >> 3;
      this.bits[byte] |= 1 << (index & 7);
    }
    this.added++;
    this.version++;
  }

  /** False positives are possible; false negatives never are. */
  has(key: string): boolean {
    for (const index of this.indexes(key)) {
      const byte = index >> 3;
      if (!(this.bits[byte] & (1 << (index & 7)))) return false;
    }
    return true;
  }

  /** Adds the cid and each link of a content, independently. Returns how many keys were new. */
  addContent(input: ContentIdentity): number {
    const keys = contentKeys(input);
    let added = 0;
    for (const key of keys) {
      if (!this.has(key)) added++;
      this.add(key);
    }
    return added;
  }

  /** True when the cid or any link of the content collides with the filter. */
  seesContent(input: ContentIdentity): boolean {
    return contentKeys(input).some((key) => this.has(key));
  }

  /** True when nothing was ever added (the bits are all still clear). */
  isEmpty(): boolean {
    return this.bits.every((byte) => byte === 0);
  }
}

/** How big a filter may be to travel inside a search request (a few kilobytes). */
export const BLOOM_INLINE_MAX_BYTES = 4 * 1024;
