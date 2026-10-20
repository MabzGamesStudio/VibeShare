// Where the web client keeps the user's data: IndexedDB of the site it is hosted on.
import { normalizeSettings } from '../../../src/shared/clientdefaults';
import { generateIdentity, identityFromSeed, randomId, type Identity } from '../../../src/shared/crypto';
import type { StoredAccount } from '../../../src/shared/nodeclient';
import {
  emptyClientData,
  formatSeed,
  parseSeed,
  type ChunkStore,
  type ClientData,
  type ClientStoreLike,
  type Doc,
  type UploadedFile,
  type UploadStore,
} from '../../../src/client/model';
import { notFound } from '../../../src/shared/errors';

/** A small key-value store: IndexedDB in browsers, a Map in tests. */
export interface KeyValue {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** The keys that start with `prefix`, in order. */
  keys(prefix: string): Promise<string[]>;
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function openIndexedDb(name = 'vibeshare'): Promise<KeyValue> {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  const db = await promised(open);
  const store = (mode: IDBTransactionMode) => db.transaction('kv', mode).objectStore('kv');
  return {
    get: (key) => promised(store('readonly').get(key)),
    set: async (key, value) => void (await promised(store('readwrite').put(value, key))),
    delete: async (key) => void (await promised(store('readwrite').delete(key))),
    keys: async (prefix) =>
      ((await promised(store('readonly').getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)))) as string[]),
  };
}

export function memoryKeyValue(): KeyValue {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => structuredClone(map.get(key)) as never,
    set: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => void map.delete(key),
    keys: async (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

/** A document saved to the key-value store shortly after each change. */
class SavedDoc<T> implements Doc<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> = Promise.resolve();
  /** Applied to the copy that is written out (e.g. to seal hidden profiles at rest). */
  prepare?: (data: T) => T;

  constructor(
    private readonly kv: KeyValue,
    private readonly key: string,
    public data: T
  ) {}

  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), 50);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // JSON round trip: the data is plain JSON, and this drops anything that is not.
    const snapshot = JSON.parse(JSON.stringify(this.prepare ? this.prepare(this.data) : this.data));
    this.pending = this.pending.then(() => this.kv.set(this.key, snapshot)).catch((error) => console.error('Could not save', error));
    return this.pending;
  }

  saved(): Promise<void> {
    return this.timer ? this.flush() : this.pending;
  }
}

export class WebStore implements ClientStoreLike {
  private constructor(
    private readonly kv: KeyValue,
    readonly data: SavedDoc<ClientData>,
    readonly accounts: SavedDoc<{ accounts: Record<string, StoredAccount> }>,
    public identity: Identity,
    /** True the first time this browser runs the client. */
    readonly fresh: boolean
  ) {}

  static async open(kv: KeyValue): Promise<WebStore> {
    const saved = await kv.get<{ seed: string }>('identity');
    let identity: Identity;
    if (saved?.seed) identity = identityFromSeed(parseSeed(saved.seed));
    else {
      identity = generateIdentity();
      await kv.set('identity', { seed: formatSeed(identity.seed), id: identity.id });
    }
    const client = (await kv.get<ClientData>('client')) ?? null;
    const data = { ...emptyClientData(), ...client };
    data.settings = normalizeSettings(data.settings);
    const accounts = (await kv.get<{ accounts: Record<string, StoredAccount> }>('accounts')) ?? { accounts: {} };
    return new WebStore(kv, new SavedDoc(kv, 'client', data), new SavedDoc(kv, 'accounts', accounts), identity, !client);
  }

  changed(): void {
    this.data.changed();
  }

  replaceIdentity(seed: Uint8Array): Identity {
    this.identity = identityFromSeed(seed);
    void this.kv.set('identity', { seed: formatSeed(this.identity.seed), id: this.identity.id });
    return this.identity;
  }

  /** While a hidden profile is active, its identity is not kept in the clear at rest. */
  hideIdentity(): void {
    void this.kv.set('identity', { sealed: true });
  }

  /** Resolves once every change so far is stored. */
  async saved(): Promise<void> {
    await Promise.all([this.data.saved(), this.accounts.saved()]);
  }
}

/** Downloaded chunks in the key-value store, evicted least recently used first. */
export class WebChunkCache implements ChunkStore {
  private index = new Map<string, number>();
  private used = 0;

  private constructor(
    private readonly kv: KeyValue,
    private readonly limitBytes: () => number
  ) {}

  static async open(kv: KeyValue, limitBytes: () => number): Promise<WebChunkCache> {
    const cache = new WebChunkCache(kv, limitBytes);
    const saved = (await kv.get<[string, number][]>('chunk-index')) ?? [];
    for (const [id, size] of saved) {
      cache.index.set(id, size);
      cache.used += size;
    }
    return cache;
  }

  private saveIndex(): void {
    void this.kv.set('chunk-index', [...this.index.entries()]);
  }

  async get(id: string): Promise<Buffer | null> {
    const size = this.index.get(id);
    if (size === undefined) return null;
    const data = await this.kv.get<Uint8Array>(`chunk:${id}`);
    if (!data) {
      this.index.delete(id);
      this.used -= size;
      this.saveIndex();
      return null;
    }
    this.index.delete(id);
    this.index.set(id, size);
    return Buffer.from(data);
  }

  async put(id: string, data: Buffer): Promise<void> {
    if (this.index.has(id) || data.length > this.limitBytes()) return;
    await this.kv.set(`chunk:${id}`, new Uint8Array(data));
    this.index.set(id, data.length);
    this.used += data.length;
    for (const [old, size] of this.index) {
      if (this.used <= this.limitBytes()) break;
      this.index.delete(old);
      this.used -= size;
      await this.kv.delete(`chunk:${old}`);
    }
    this.saveIndex();
  }

  usage(): { bytes: number; chunks: number } {
    return { bytes: this.used, chunks: this.index.size };
  }

  async clear(): Promise<void> {
    for (const id of this.index.keys()) await this.kv.delete(`chunk:${id}`);
    this.index.clear();
    this.used = 0;
    this.saveIndex();
  }
}

/** Files handed over for publishing, kept in memory until published. */
export class MemoryUploads implements UploadStore {
  private files = new Map<string, Blob>();

  putBlob(file: Blob): { fileId: string; size: number } {
    const fileId = randomId('f', 10);
    this.files.set(fileId, file);
    return { fileId, size: file.size };
  }

  /** Takes bytes (e.g. pulled from a URL by the client) as a file to publish. */
  async put(data: Uint8Array): Promise<{ fileId: string; size: number }> {
    return this.putBlob(new Blob([data as BlobPart]));
  }

  async get(fileId: string): Promise<UploadedFile> {
    const file = this.files.get(fileId);
    if (!file) throw notFound('The uploaded file is gone; upload it again');
    return {
      size: file.size,
      read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
    };
  }

  async remove(fileId: string): Promise<void> {
    this.files.delete(fileId);
  }
}
