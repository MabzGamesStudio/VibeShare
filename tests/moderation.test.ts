import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateIdentity } from '../src/shared/crypto.js';
import { ADMIN, admin, clientFor, startProvider } from './helpers.js';

describe('operator moderation: bans, suspensions, rate limits', () => {
  it('bans an account for good, and lifting the ban lets it back in', async () => {
    const node = await startProvider();
    try {
      const identity = generateIdentity();
      const client = clientFor(node.url(), 'identity', identity);
      const before = await client.json<{ account: { id: string } }>('/v1/account');
      assert.equal(before.account.id, identity.id);

      const { entry } = await admin<{ entry: { id: string } }>(node.url(), '/v1/admin/moderation', {
        body: { subject: 'account', target: identity.id, action: 'permaban', reason: 'spam' },
      });
      await assert.rejects(client.json('/v1/account'), /Banned: spam/);

      // The operator is never locked out, and lifting the ban works.
      await admin(node.url(), `/v1/admin/moderation/${entry.id}`, { method: 'DELETE' });
      const back = await client.json<{ account: { id: string } }>('/v1/account');
      assert.equal(back.account.id, identity.id);
    } finally {
      await node.stop();
    }
  });

  it('suspends an account for a while only: the ban runs out on its own', async () => {
    const node = await startProvider();
    try {
      const identity = generateIdentity();
      const client = clientFor(node.url(), 'identity', identity);
      await admin(node.url(), '/v1/admin/moderation', {
        body: { subject: 'account', target: identity.id, action: 'tempban', until: new Date(Date.now() + 250).toISOString() },
      });
      await assert.rejects(client.json('/v1/account'), /Suspended/);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const back = await client.json<{ account: { id: string } }>('/v1/account');
      assert.equal(back.account.id, identity.id);
    } finally {
      await node.stop();
    }
  });

  it('rate limits an account to a number of requests per minute', async () => {
    const node = await startProvider();
    try {
      const identity = generateIdentity();
      const client = clientFor(node.url(), 'identity', identity);
      await admin(node.url(), '/v1/admin/moderation', {
        body: { subject: 'account', target: identity.id, action: 'ratelimit', perMinute: 3 },
      });
      for (let i = 0; i < 3; i++) await client.json('/v1/account');
      await assert.rejects(client.json('/v1/account'), /rate limited/);
    } finally {
      await node.stop();
    }
  });

  it('bans a whole IP address, but never the admin', async () => {
    const node = await startProvider();
    try {
      const identity = generateIdentity();
      const client = clientFor(node.url(), 'identity', identity);
      const { entry } = await admin<{ entry: { id: string } }>(node.url(), '/v1/admin/moderation', {
        body: { subject: 'ip', target: '127.0.0.1', action: 'permaban', reason: 'flood' },
      });
      await assert.rejects(client.json('/v1/account'), /Banned: flood/);
      const status = await admin<{ reference: string }>(node.url(), '/v1/admin/status');
      assert.ok(status.reference.startsWith('vs:provider:'));
      await admin(node.url(), `/v1/admin/moderation/${entry.id}`, { method: 'DELETE' });
      await client.json('/v1/account');
    } finally {
      await node.stop();
    }
  });

  it('shares bans with peers when syncing, and the peer enforces them too', async () => {
    const a = await startProvider({ name: 'Peer A' });
    const b = await startProvider({ name: 'Peer B' });
    try {
      await admin(a.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: b.reference(), send: true, receive: true }] } });
      await admin(b.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: a.reference(), send: true, receive: true }] } });

      const identity = generateIdentity();
      const onB = clientFor(b.url(), 'identity', identity);
      await onB.json('/v1/account');

      await admin(a.url(), '/v1/admin/moderation', { body: { subject: 'account', target: identity.id, action: 'permaban', reason: 'spam network' } });
      const synced = await admin<{ peers: number; accepted: number }>(a.url(), '/v1/admin/moderation/sync', { method: 'POST', body: {} });
      assert.equal(synced.peers, 1, 'the ban went out to the peer');

      const onBList = await admin<{ entries: { target: string; reason?: string }[] }>(b.url(), '/v1/admin/moderation');
      assert.ok(onBList.entries.some((entry) => entry.target === identity.id), 'the peer kept the ban');
      await assert.rejects(onB.json('/v1/account'), /Banned: spam network/, 'and enforces it');
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});