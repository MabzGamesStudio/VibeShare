import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { buildManifestFromBuffer, chunkIdOf, contentIdOf, MiB, type Manifest } from '../src/shared/content.js';
import { RemoteError } from '../src/shared/http.js';
import { admin, clientFor, randomBytesOf, startProvider } from './helpers.js';

describe('provider node', async () => {
  const provider = await startProvider({
    signup: { grant: 10, powBits: 0 },
    pricing: { perMiB: 2, freeMiBPerDay: 0, creatorShare: 0.5 },
  });
  const url = provider.url();
  after(() => provider.stop());

  const data = randomBytesOf(Math.floor(2.5 * MiB));
  let cid = '';
  let manifest: Manifest;

  it('serves signed info and a reference', async () => {
    const client = clientFor(url);
    const info = await client.fetchInfo();
    assert.equal(info.type, 'provider');
    assert.equal(info.id, provider.identity.id);
    assert.match(provider.reference(), /^vs:provider:vk1[a-z2-7]{52}@http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('accepts uploads chunk by chunk', async () => {
    const uploader = clientFor(url, 'identity');
    manifest = await buildManifestFromBuffer(data, { name: 'clip.bin', mime: 'application/octet-stream' });
    cid = contentIdOf(manifest);
    const started = await uploader.json<{ cid: string; missing: string[] }>('/v1/uploads', { body: { manifest } });
    assert.equal(started.cid, cid);
    assert.equal(started.missing.length, 3);
    const bytes = new Map<string, Buffer>();
    for (let i = 0; i < manifest.chunks.length; i++) {
      bytes.set(manifest.chunks[i].id, data.subarray(i * MiB, (i + 1) * MiB));
    }
    await assert.rejects(uploader.json(`/v1/uploads/${cid}/commit`, { method: 'POST' }), /missing/);
    for (const id of started.missing) {
      await uploader.fetch(`/v1/uploads/${cid}/chunks/${id}`, { method: 'PUT', raw: bytes.get(id)! });
    }
    const done = await uploader.json<{ status: string }>(`/v1/uploads/${cid}/commit`, { method: 'POST' });
    assert.equal(done.status, 'ready');
  });

  it('charges credits per MiB and refuses when the balance runs out', async () => {
    const viewer = clientFor(url, 'pseudonym');
    const fetched = await viewer.json<Manifest>(`/v1/content/${cid}`);
    assert.equal(contentIdOf(fetched), cid);
    const first = await viewer.fetch(`/v1/chunks/${fetched.chunks[0].id}?cid=${cid}`);
    assert.equal(first.headers.get('x-vs-charged'), '2');
    assert.equal(first.headers.get('x-vs-balance'), '8');
    const body = Buffer.from(await first.arrayBuffer());
    assert.equal(chunkIdOf(body), fetched.chunks[0].id);
    await viewer.fetch(`/v1/chunks/${fetched.chunks[1].id}?cid=${cid}`);
    await viewer.fetch(`/v1/chunks/${fetched.chunks[2].id}?cid=${cid}`);
    const account = await viewer.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 5); // 2 + 2 + 1 (the last chunk is half a MiB)
    // the uploader got half of each charge
    const uploaderAccount = provider.ledger.all().find((a) => a.kind === 'key' && a.recent.some((e) => e.reason === 'creator share'));
    assert.ok(uploaderAccount);
    const quote = await viewer.json<{ total: number }>(`/v1/quote/${cid}`);
    assert.equal(quote.total, 5);
  });

  it('returns 402 when the account cannot pay', async () => {
    const viewer = clientFor(url, 'anonymous');
    for (let i = 0; i < 5; i++) await viewer.fetch(`/v1/chunks/${manifest.chunks[0].id}?cid=${cid}`);
    await assert.rejects(viewer.fetch(`/v1/chunks/${manifest.chunks[0].id}?cid=${cid}`), (error: RemoteError) => {
      assert.equal(error.status, 402);
      return true;
    });
  });

  it('redeems vouchers created by the operator', async () => {
    const { codes } = await admin<{ codes: string[] }>(url, '/v1/admin/vouchers', { body: { credits: 100, count: 2 } });
    const viewer = clientFor(url, 'anonymous');
    const result = await viewer.json<{ credited: number; balance: number }>('/v1/payments/voucher/claim', {
      body: { code: codes[0].toLowerCase() },
    });
    assert.equal(result.credited, 100);
    assert.equal(result.balance, 110);
    await assert.rejects(viewer.json('/v1/payments/voucher/claim', { body: { code: codes[0] } }), /already redeemed/);
  });

  it('reports which content it has, and lists its catalog', async () => {
    const viewer = clientFor(url);
    const has = await viewer.json<{ has: Record<string, boolean> }>('/v1/has', { body: { ids: [cid, 'vs1nope'] }, auth: false });
    assert.deepEqual(has.has, { [cid]: true, vs1nope: false });
    const catalog = await viewer.json<{ items: { cid: string }[] }>('/v1/catalog', { auth: false });
    assert.equal(catalog.items[0].cid, cid);
  });

  it('deletes content and its chunks', async () => {
    await admin(url, `/v1/admin/content/${cid}`, { method: 'DELETE' });
    assert.equal(provider.store.hasChunk(manifest.chunks[0].id), false);
  });
});
