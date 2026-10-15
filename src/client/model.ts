// What a client keeps, independent of where it keeps it: files for the desktop and
// command-line client, IndexedDB for the web client. Browser-safe.
import type { HistoryItem, LibraryItem, NodeEntry, Settings, Subscription } from '../shared/clientapi.js';
import { defaultSettings } from '../shared/clientdefaults.js';
import type { Identity } from '../shared/crypto.js';
import { base32Decode, base32Encode } from '../shared/encoding.js';
import type { StoredAccount } from '../shared/nodeclient.js';
import type { ProfileAccess, SealedBlob } from '../shared/profiles.js';

/** One profile of the client: its own nodes, settings, history and client id. */
export interface ProfileRecord {
  id: string;
  name: string;
  /** public: anyone using this client may switch to it; password: username + password. */
  access: ProfileAccess;
  /**
   * Hidden profiles do not appear in the profile list at all, and everything below
   * (name included) is only stored inside `sealed` — encrypted with the profile's
   * password. The plaintext fields stay empty at rest.
   */
  hidden?: boolean;
  /** The encrypted data of a hidden profile. */
  sealed?: SealedBlob;
  /** The profile's own client id (its key seed, base32). */
  identitySeed: string;
  nodes: NodeEntry[];
  settings: Settings;
  subscriptions: Subscription[];
  library: LibraryItem[];
  history: HistoryItem[];
}

/** What a profile keeps; the payload sealed inside a hidden profile's blob. */
export interface ProfilePayload {
  name: string;
  identitySeed: string;
  nodes: NodeEntry[];
  settings: Settings;
  subscriptions: Subscription[];
  library: LibraryItem[];
  history: HistoryItem[];
}

export interface ClientData {
  /** The active profile's data (what the client uses); mirrored into `profiles` on switch. */
  nodes: NodeEntry[];
  settings: Settings;
  subscriptions: Subscription[];
  library: LibraryItem[];
  history: HistoryItem[];
  /** Every profile of this client. Empty = the implicit single profile. */
  profiles: ProfileRecord[];
  /** The id of the profile whose data fills the fields above. */
  activeProfile: string;
}

export function emptyClientData(): ClientData {
  return {
    nodes: [],
    settings: defaultSettings(),
    subscriptions: [],
    library: [],
    history: [],
    profiles: [],
    activeProfile: 'main',
  };
}

/**
 * The form of the data that is saved: hidden profiles never keep plaintext there.
 * Their fields (name, client id, nodes, settings, history) live only inside the
 * sealed blob, and while a hidden profile is active the live fields are left out
 * too — they are sealed into its blob on every change instead.
 */
export function prepareClientSave(data: ClientData): ClientData {
  const hiddenActive = data.profiles?.some((profile) => profile.id === data.activeProfile && profile.hidden) ?? false;
  return {
    ...data,
    nodes: hiddenActive ? [] : data.nodes,
    settings: hiddenActive ? defaultSettings() : data.settings,
    subscriptions: hiddenActive ? [] : data.subscriptions,
    library: hiddenActive ? [] : data.library,
    history: hiddenActive ? [] : data.history,
    profiles: (data.profiles ?? []).map((profile) =>
      profile.hidden
        ? {
            ...profile,
            name: '',
            identitySeed: '',
            nodes: [],
            settings: defaultSettings(),
            subscriptions: [],
            library: [],
            history: [],
          }
        : profile
    ),
  };
}

/** A document held in memory and saved shortly after each `changed()`. */
export interface Doc<T> {
  data: T;
  changed(): void;
  /** Applied to the copy that is written out (e.g. to seal hidden profiles at rest). */
  prepare?: (data: T) => T;
}

export interface ClientStoreLike {
  readonly data: Doc<ClientData>;
  readonly accounts: Doc<{ accounts: Record<string, StoredAccount> }>;
  identity: Identity;
  changed(): void;
  replaceIdentity(seed: Buffer): Identity;
  /** While a hidden profile is active its id is not kept in the clear at rest. */
  hideIdentity?(): void | Promise<void>;
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
  /** Takes bytes (e.g. pulled from a URL) as a file to publish. */
  put(data: Uint8Array): Promise<{ fileId: string; size: number }>;
  /** Streams bytes in (large downloads from a URL), when the host supports it. */
  putStream?(stream: ReadableStream<Uint8Array>): Promise<{ fileId: string; size: number }>;
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
