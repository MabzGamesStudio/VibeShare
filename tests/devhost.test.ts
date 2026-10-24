import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bytesCid } from '../src/shared/content.js';
import { clientFor, randomBytesOf, startClient, startProvider, tempDir } from './helpers.js';

describe('developer static data host (dev builds only)', () => {
  it('hosts bytes by content id, refuses mismatched ones, and powers the URL → credits round trip', async () => {
    const provider = await startProvider({ contentUrls: { autoAccept: true, creditPerDownload: 5, maxUrlsPerClient: 4, maxBaseUrlsPerClient: 4 } });
    const url = provider.url();
    try {
      // The dev host exists here (a source build) and holds what is uploaded to it.
      const data = randomBytesOf(2048, 3);
      const cid = bytesCid(data);
      const client = clientFor(url, 'identity');
      const put = await client.json<{ ok: boolean; size: number }>(`/v1/dev/host/${cid}`, { method: 'PUT', raw: data });
      assert.equal(put.ok, true);
      assert.equal(put.size, data.length);

      const hosted = Buffer.from(await (await fetch(`${url}/v1/dev/host/${cid}`)).arrayBuffer());
      assert.ok(hosted.equals(data), 'served back exactly');
      const viaBase = Buffer.from(await (await fetch(`${url}/v1/dev/host/base/${cid}`)).arrayBuffer());
      assert.ok(viaBase.equals(data), 'and at the base-URL shape too');

      const wrong = randomBytesOf(64, 9);
      await assert.rejects(client.json(`/v1/dev/host/${bytesCid(wrong)}`, { method: 'PUT', raw: data }), /do not hash to this cid/);

      // The local round trip: offer the dev-host URL as the copy of the cid, have the
      // provider pull it, and watch the credits arrive.
      const before = (await client.json<{ account: { balance: number } }>('/v1/account')).account.balance;
      await client.json('/v1/content-urls', { body: { cid, url: `${url}/v1/dev/host/${cid}` } });
      const fetched = await client.json<{ fetched: boolean; downloaded: boolean }>('/v1/content-urls/fetch', { body: { cid } });
      assert.equal(fetched.downloaded, true);
      const after = (await client.json<{ account: { balance: number } }>('/v1/account')).account.balance;
      assert.equal(after, before + 5, 'credited for the download from the offered URL');

      // The same through a base URL.
      const data2 = randomBytesOf(1024, 4);
      const cid2 = bytesCid(data2);
      await client.json(`/v1/dev/host/${cid2}`, { method: 'PUT', raw: data2 });
      await client.json('/v1/content-urls', { body: { baseUrl: `${url}/v1/dev/host/base` } });
      const fetched2 = await client.json<{ downloaded: boolean }>('/v1/content-urls/fetch', { body: { cid: cid2 } });
      assert.equal(fetched2.downloaded, true, 'the provider queried <base>/<cid> and found it');
    } finally {
      await provider.stop();
    }
  });

  it('is reachable through the client API for the GUI, and gated on dev builds', async () => {
    const provider = await startProvider({ contentUrls: { autoAccept: true, creditPerDownload: 3, maxUrlsPerClient: 4, maxBaseUrlsPerClient: 4 } });
    const { dir, cleanup } = tempDir();
    const { client: node, api } = await startClient(dir);
    try {
      const info = await api<{ dev: boolean }>('/api/dev/info');
      assert.equal(info.dev, true, 'running from source is a dev build');
      await api('/api/nodes', { body: { text: provider.reference() } });
      const state = await api<{ nodes: { id: string; type: string }[] }>('/api/state');
      const pid = state.nodes.find((n) => n.type === 'provider')!.id;

      // Upload a file to the provider by content id from the client, then list it there.
      const data = randomBytesOf(512, 21);
      const cid = bytesCid(data);
      const put = await api<{ ok: boolean }>(`/api/nodes/${pid}/dev-host`, { body: { cid, data: data.toString('base64url') } });
      assert.equal(put.ok, true);
      const listed = await api<{ files: { cid: string }[] }>(`/api/nodes/${pid}/dev-host`);
      assert.ok(listed.files.some((file) => file.cid === cid), 'it is listed among the hosted data');

      // Offer it and fetch it through the client API: the credits land on this account.
      const before = (await api<{ account: { balance: number } }>(`/api/nodes/${pid}/account`)).account.balance;
      await api(`/api/nodes/${pid}/content-urls`, { body: { items: [{ cid, url: `${provider.url()}/v1/dev/host/${cid}` }] } });
      const fetched = await api<{ downloaded: boolean }>(`/api/nodes/${pid}/content-urls/fetch`, { body: { cid } });
      assert.equal(fetched.downloaded, true);
      const after = (await api<{ account: { balance: number } }>(`/api/nodes/${pid}/account`)).account.balance;
      assert.equal(after, before + 3, 'credited through the client API');
    } finally {
      await node.stop();
      await provider.stop();
      cleanup();
    }
  });
});