import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentity, identityFromSeed, type Identity } from '../shared/crypto.js';
import { normalizeSettings } from '../shared/clientdefaults.js';
import { emptyClientData, formatSeed, parseSeed, type ClientData, type ClientStoreLike } from './model.js';
import type { StoredAccount } from '../shared/nodeclient.js';
import { JsonFile } from '../shared/store.js';

export type { ClientData } from './model.js';
export { defaultSettings } from '../shared/clientdefaults.js';
export { formatSeed, parseSeed } from './model.js';

/** Everything the client keeps on disk: identity, nodes, settings, accounts, library. */
export class ClientStore implements ClientStoreLike {
  readonly data: JsonFile<ClientData>;
  readonly accounts: JsonFile<{ accounts: Record<string, StoredAccount> }>;
  identity: Identity;

  constructor(private readonly dir: string | null) {
    this.identity = this.loadIdentity();
    this.data = new JsonFile<ClientData>(this.path('client.json'), emptyClientData);
    this.data.data.settings = normalizeSettings(this.data.data.settings);
    this.accounts = new JsonFile(this.path('accounts.json'), () => ({ accounts: {} }));
  }

  path(name: string): string | null {
    return this.dir ? join(this.dir, name) : null;
  }

  private loadIdentity(): Identity {
    const file = this.path('identity.json');
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { seed?: string };
        if (saved.seed) return identityFromSeed(parseSeed(saved.seed));
      } catch {
        // fall through to a fresh identity
      }
    }
    const identity = generateIdentity();
    this.saveIdentity(identity);
    return identity;
  }

  private saveIdentity(identity: Identity): void {
    const file = this.path('identity.json');
    if (file) writeFileSync(file, JSON.stringify({ seed: formatSeed(identity.seed), id: identity.id }, null, 2), { mode: 0o600 });
  }

  replaceIdentity(seed: Uint8Array): Identity {
    this.identity = identityFromSeed(seed);
    this.saveIdentity(this.identity);
    // Anonymous tokens stay valid; key-based sessions are re-opened with the new key.
    return this.identity;
  }

  /** While a hidden profile is active, its identity is not kept in the clear at rest. */
  hideIdentity(): void {
    const file = this.path('identity.json');
    if (file) writeFileSync(file, JSON.stringify({ sealed: true }), { mode: 0o600 });
  }

  changed(): void {
    this.data.changed();
  }

  flush(): void {
    this.data.flush();
    this.accounts.flush();
  }
}
