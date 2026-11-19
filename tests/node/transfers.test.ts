// Sending credits between accounts of one node: to a key id, to a creator id (resolved
// through the algorithm catalog), the minimum-sender gate, and the client API route.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { generateIdentity } from '../../src/shared/crypto.js';
import { clientFor, startAlgorithm, startClient, startProvider, tempDir } from '../helpers.js';

describe('credit transfers', async () => {
  const provider = await startProvider({ signup: { grant: 2000 } });
  const algorithm = await startAlgorithm({ signup: { grant: 2000 } });
  const workspace = tempDir();
  const { client, api } = await startClient(workspace.dir);
  after(async () => {
    await client.stop();
    await algorithm.stop();
    await provider.stop();
    workspace.cleanup();
  });

  it('sends credits to a key id and creates the recipient account (no signup grant)', async () => {
    const sender = clientFor(provider.url(), 'identity');
    const recipient = generateIdentity();
    const answer = await sender.json<{ transfer: { to: string; amount: number; balance: number; minSenderBalance: number } }>(
      '/v1/credits/transfer',
      { body: { to: recipient.id, amount: 500 } }
    );
    assert.equal(answer.transfer.to, recipient.id);
    assert.equal(answer.transfer.amount, 500);
    assert.equal(answer.transfer.balance, 1500, 'the sender pays the transfer');
    assert.equal(answer.transfer.minSenderBalance, 1000, 'the node publishes its gate');
    // The recipient never signed in here: their account exists with exactly what was sent.
    const receiver = clientFor(provider.url(), 'identity', recipient);
    const me = await receiver.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(me.account.balance, 500);
  });

  it('resolves a creator id to the account of its signing key on an algorithm node', async () => {
    const creatorKey = generateIdentity();
    const creatorId = 'yt:UCX6OQ3DkcsbYNE6H8uQQuVA';
    algorithm.registry.upsertCreator({ id: creatorId, name: 'Sample Creator', kind: 'person', keys: [creatorKey.id] });
    const sender = clientFor(algorithm.url(), 'identity');
    // The id arrives percent-encoded from a link, as users paste it.
    const answer = await sender.json<{ transfer: { to: string; toName?: string } }>('/v1/credits/transfer', {
      body: { to: encodeURIComponent(creatorId), amount: 250 },
    });
    assert.equal(answer.transfer.to, creatorKey.id);
    assert.equal(answer.transfer.toName, 'Sample Creator');
    assert.equal(algorithm.ledger.get(creatorKey.id)?.balance, 250);
  });

  it('refuses a sender below the node minimum and a transfer above the balance', async () => {
    const poor = await startProvider({ signup: { grant: 100 } });
    try {
      const sender = clientFor(poor.url(), 'identity');
      await assert.rejects(
        sender.json('/v1/credits/transfer', { body: { to: generateIdentity().id, amount: 50 } }),
        /at least 1000 credits/
      );
    } finally {
      await poor.stop();
    }
    const rich = clientFor(provider.url(), 'identity');
    await assert.rejects(rich.json('/v1/credits/transfer', { body: { to: generateIdentity().id, amount: 9000 } }), /Not enough credits/);
  });

  it('answers a clear error for a creator this node cannot resolve', async () => {
    const sender = clientFor(provider.url(), 'identity');
    await assert.rejects(sender.json('/v1/credits/transfer', { body: { to: 'yt:nobody-here', amount: 10 } }), /No creator/);
    await assert.rejects(sender.json('/v1/credits/transfer', { body: { to: 'not a recipient', amount: 10 } }), /Give the recipient/);
  });

  it('is reachable through the local client API with the same rules', async () => {
    await api('/api/nodes', { body: { text: provider.reference() } });
    const found = client.core.nodes.list().find((entry) => entry.url.includes(String(new URL(provider.url()).port))) ?? client.core.nodes.list()[0];
    const answer = await api<{ transfer: { to: string; amount: number; balance: number } }>('/api/credits/transfer', {
      body: { nodeId: found.id, to: generateIdentity().id, amount: 100 },
    });
    assert.equal(answer.transfer.amount, 100);
    await assert.rejects(api('/api/credits/transfer', { body: { nodeId: found.id, to: 'nope', amount: 100 } }), /Give the recipient/);
  });
});
