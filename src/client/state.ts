import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { base32Decode, base32Encode } from '../shared/encoding.js';
import { generateIdentity, identityFromSeed, type Identity } from '../shared/crypto.js';
import type { HistoryItem, LibraryItem, NodeEntry, Settings, Subscription } from '../shared/clientapi.js';
import type { StoredAccount } from '../shared/nodeclient.js';
import { JsonFile } from '../shared/store.js';

export interface ClientData {
  nodes: NodeEntry[];
  settings: Settings;
  subscriptions: Subscription[];
  library: LibraryItem[];
  history: HistoryItem[];
}

export function defaultSettings(): Settings {
  return {
    preferences: { maxRating: '16+', formats: [], topics: [], blockedTags: [], blockedCreators: [], creatorKinds: [], languages: [] },
    feedMode: 'blend',
    unknownContent: 'warn',
    defaultAuth: 'pseudonym',
    autoplay: true,
    cacheMiB: 1024,
    ipfsGateway: 'https://ipfs.io',
    profile: { name: '', kind: 'person' },
    storageService: { enabled: false, quotaGiB: 5, providers: [] },
    theme: 'system',
  };
}

const SEED_PREFIX = 'vibeshare-seed-';

export function formatSeed(seed: Buffer): string {
  return SEED_PREFIX + base32Encode(seed);
}

export function parseSeed(text: string): Buffer {
  const clean = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!clean.startsWith(SEED_PREFIX)) throw new Error('A backup starts with vibeshare-seed-');
  const seed = base32Decode(clean.slice(SEED_PREFIX.length));
  if (seed.length !== 32) throw new Error('The backup is incomplete');
  return seed;
}

/** Everything the client keeps on disk: identity, nodes, settings, accounts, library. */
export class ClientStore {
  readonly data: JsonFile<ClientData>;
  readonly accounts: JsonFile<{ accounts: Record<string, StoredAccount> }>;
  identity: Identity;

  constructor(private readonly dir: string | null) {
    this.identity = this.loadIdentity();
    this.data = new JsonFile<ClientData>(this.path('client.json'), () => ({
      nodes: [],
      settings: defaultSettings(),
      subscriptions: [],
      library: [],
      history: [],
    }));
    const settings = defaultSettings();
    this.data.data.settings = {
      ...settings,
      ...this.data.data.settings,
      preferences: { ...settings.preferences, ...this.data.data.settings?.preferences },
      profile: { ...settings.profile, ...this.data.data.settings?.profile },
      storageService: { ...settings.storageService, ...this.data.data.settings?.storageService },
    };
    this.accounts = new JsonFile(this.path('accounts.json'), () => ({ accounts: {} }));
  }

  path(name: string): string | null {
    return this.dir ? join(this.dir, name) : null;
  }

  private loadIdentity(): Identity {
    const file = this.path('identity.json');
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { seed: string };
      return identityFromSeed(parseSeed(saved.seed));
    }
    const identity = generateIdentity();
    this.saveIdentity(identity);
    return identity;
  }

  private saveIdentity(identity: Identity): void {
    const file = this.path('identity.json');
    if (file) writeFileSync(file, JSON.stringify({ seed: formatSeed(identity.seed), id: identity.id }, null, 2), { mode: 0o600 });
  }

  replaceIdentity(seed: Buffer): Identity {
    this.identity = identityFromSeed(seed);
    this.saveIdentity(this.identity);
    // Anonymous tokens stay valid; key-based sessions are re-opened with the new key.
    return this.identity;
  }

  changed(): void {
    this.data.changed();
  }

  flush(): void {
    this.data.flush();
    this.accounts.flush();
  }
}
