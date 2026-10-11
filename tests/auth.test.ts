import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { generateIdentity, signData, solveProofOfWork } from '../src/shared/crypto.js';
import { RemoteError } from '../src/shared/http.js';
import { powInput, sessionSigningPayload } from '../src/shared/protocol.js';
import { NodeClient } from '../src/shared/nodeclient.js';
import { helpers } from '../src/algorithm/ranking.js';
import type { Entry } from '../src/algorithm/registry.js';
import { clientFor, startProvider } from './helpers.js';

describe('accounts and abuse protection', async () => {
  const node = await startProvider({ signup: { grant: 50, powBits: 12, anonymous: false, perIpPerHour: 3 } });
  const url = node.url();
  after(() => node.stop());

  const post = (path: string, body: unknown) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('needs proof of work to open an account, and the client solves it', async () => {
    const identity = generateIdentity();
    const ts = Date.now();
    const sig = signData(identity, sessionSigningPayload(node.identity.id, ts));
    const refused = await post('/v1/auth/session', { key: identity.id, ts, sig });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'pow_required');
    const client = new NodeClient({ url, auth: 'identity', identity });
    const account = await client.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 50);
  });

  it('refuses replayed signatures and stale timestamps', async () => {
    const identity = generateIdentity();
    const ts = Date.now();
    const body = {
      key: identity.id,
      ts,
      sig: signData(identity, sessionSigningPayload(node.identity.id, ts)),
      pow: solveProofOfWork(powInput(node.identity.id, identity.id, ts), 12),
    };
    assert.equal((await post('/v1/auth/session', body)).status, 200);
    assert.equal((await post('/v1/auth/session', body)).status, 403, 'replay');
    const old = Date.now() - 3600_000;
    const stale = await post('/v1/auth/session', { key: identity.id, ts: old, sig: signData(identity, sessionSigningPayload(node.identity.id, old)) });
    assert.equal(stale.status, 400);
    const otherNode = await post('/v1/auth/session', { key: identity.id, ts, sig: signData(identity, sessionSigningPayload('vk1other', ts)) });
    assert.equal(otherNode.status, 401, 'a signature made for another node is useless here');
  });

  it('can turn off anonymous accounts and limit signups per address', async () => {
    await assert.rejects(clientFor(url, 'anonymous').json('/v1/account'), (e: RemoteError) => e.status === 403);
    // Two key accounts were opened above; the third is allowed, the fourth is not.
    await clientFor(url, 'identity').json('/v1/account');
    await assert.rejects(clientFor(url, 'identity').json('/v1/account'), (e: RemoteError) => e.status === 429);
  });

  it('rejects unknown bearer tokens', async () => {
    const response = await fetch(url + '/v1/account', { headers: { authorization: 'Bearer nope' } });
    assert.equal(response.status, 401);
  });
});

describe('the example ranking module', () => {
  it('returns a score for every entry', async () => {
    const module = (await import(pathToFileURL(join(import.meta.dirname, '..', 'examples', 'ranking', 'ranker.mjs')).href)) as {
      default: (entries: Entry[], context: unknown) => Record<string, number>;
    };
    const entry = (id: string, likes: number, durationSeconds?: number) =>
      ({ id, likes, dislikes: 0, topics: ['science'], publishedAt: new Date().toISOString(), creatorId: id, durationSeconds }) as unknown as Entry;
    const scores = module.default([entry('a', 10, 900), entry('b', 0)], {
      preferences: { topics: ['science'] },
      seed: 's',
      now: Date.now(),
      config: { halfLifeHours: 72 },
      helpers,
    });
    assert.ok(scores.a > scores.b);
  });
});
