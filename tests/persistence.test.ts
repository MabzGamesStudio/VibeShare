import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ClientNode } from '../src/client/daemon.js';
import type { NodeEntry } from '../src/shared/clientapi.js';
import { startAlgorithm, startProvider, tempDir } from './helpers.js';

describe('restarts', () => {
  it('keep identities, node lists, priorities, accounts and credits', async () => {
    const { dir, cleanup } = tempDir();
    try {
      let provider = await startProvider({ signup: { grant: 42 } }, join(dir, 'provider'));
      const algorithm = await startAlgorithm({}, join(dir, 'algorithm'));
      const providerId = provider.identity.id;
      const providerPort = provider.port;

      let client = new ClientNode({ dataDir: join(dir, 'client'), port: 0, refreshIntervalMs: 3600_000 });
      await client.start();
      const identity = client.store.identity.id;
      await client.nodes.add(`${algorithm.reference()}\n${provider.reference()}`);
      const providerEntry = client.nodes.get(providerId)!;
      client.nodes.update(providerId, { auth: 'anonymous' });
      await client.nodes.refreshBalance(providerEntry);
      client.nodes.update(algorithm.identity.id, { maxPrice: 3 });
      const anonymousAccount = client.nodes.get(providerId)!.accountId;
      await client.stop();

      // The provider restarts on the same port with its data directory.
      await provider.stop();
      provider = await startProvider({ signup: { grant: 42 }, port: providerPort }, join(dir, 'provider'));
      assert.equal(provider.identity.id, providerId);

      client = new ClientNode({ dataDir: join(dir, 'client'), port: 0, refreshIntervalMs: 3600_000 });
      await client.start();
      assert.equal(client.store.identity.id, identity);
      const nodes: NodeEntry[] = client.nodes.list();
      assert.deepEqual(nodes.map((n) => n.type), ['algorithm', 'provider']);
      assert.equal(client.nodes.get(algorithm.identity.id)!.maxPrice, 3);
      await client.nodes.refreshBalance(client.nodes.get(providerId)!);
      assert.equal(client.nodes.get(providerId)!.accountId, anonymousAccount, 'the anonymous token was kept');
      assert.equal(client.nodes.get(providerId)!.balance, 42, 'the credits survived both restarts');
      await client.stop();
      await provider.stop();
      await algorithm.stop();
    } finally {
      cleanup();
    }
  });
});
