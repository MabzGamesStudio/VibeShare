// What a client keeps, independent of where it keeps it: files for the desktop and
// command-line client, IndexedDB for the web client. Browser-safe.
import type { HistoryItem, LibraryItem, NodeEntry, Settings, Subscription } from '../shared/clientapi.js';
import { defaultSettings } from '../shared/clientdefaults.js';
import type { Identity } from '../shared/crypto.js';
import { base32Decode, base32Encode } from '../shared/encoding.js';
import type { StoredAccount } from '../shared/nodeclient.js';

export interface ClientData {
  nodes: NodeEntry[];
  settings: Settings;
  subscriptions: Subscription[];
  library: LibraryItem[];
  history: HistoryItem[];
}

export function emptyClientData(): ClientData {
  return { nodes: [], settings: defaultSettings(), subscriptions: [], library: [], history: [] };
}

/** A document held in memory and saved shortly after each `changed()`. */
export interface Doc<T> {
  data: T;
  changed(): void;
}

export interface ClientStoreLike {
  readonly data: Doc<ClientData>;
  readonly accounts: Doc<{ accounts: Record<string, StoredAccount> }>;
  identity: Identity;
  changed(): void;
  replaceIdentity(seed: Buffer): Identity;
}

/** Downloaded chunks, kept up to a size limit so rewatching and seeking cost nothing. */
export interface ChunkStore {
  get(id: string): Promise<Buffer | null>;
  put(id: string, data: Buffer): Promise<void>;
  usage(): { bytes: number; chunks: number };
  clear(): Promise<void>;
}

/** A file the GUI handed over for publishing. */
export interface UploadedFile {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface UploadStore {
  get(fileId: string): Promise<UploadedFile>;
  remove(fileId: string): Promise<void>;
}

const SEED_PREFIX = 'vibeshare-seed-';

export function formatSeed(seed: Uint8Array): string {
  return SEED_PREFIX + base32Encode(seed);
}

export function parseSeed(text: string): Buffer {
  const clean = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!clean.startsWith(SEED_PREFIX)) throw new Error('A backup starts with vibeshare-seed-');
  const seed = base32Decode(clean.slice(SEED_PREFIX.length));
  if (seed.length !== 32) throw new Error('The backup is incomplete');
  return seed;
}
