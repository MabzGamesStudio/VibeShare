import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { generateIdentity, signData, type Identity } from '../src/shared/crypto.js';
import {
  claimSigningPayload,
  type AlgorithmInfo,
  type CreatorAccountLinkRequest,
  type CreatorContentResponse,
  type CreatorInfo,
  type SignedInfo,
} from '../src/shared/protocol.js';
import { admin, clientFor, startAlgorithm, startClient, tempDir } from './helpers.js';

describe('creators linking their accounts together', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());

  const creator = generateIdentity();
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company', keys: [creator.id] } });

  const proofFor = (key: Identity, subject: string) => {
    const ts = Date.now();
    return { key: key.id, ts, sig: signData(key, claimSigningPayload(node.identity.id, subject, ts)) };
  };

  it('only lets the creator (its key) link accounts, and shows them on its page', async () => {
    const impostor = generateIdentity();
    const bad: CreatorAccountLinkRequest = {
      creator: 'name:labs',
      accounts: [{ platform: 'yt', handle: '@science' }],
      proof: proofFor(impostor, 'name:labs'),
    };
    await assert.rejects(clientFor(url, 'pseudonym').json('/v1/creators/accounts', { method: 'PUT', body: bad }), /Only the creator/);

    const good: CreatorAccountLinkRequest = {
      creator: 'name:labs',
      accounts: [
        { platform: 'yt', handle: '@science', url: 'https://youtube.com/@science' },
        { platform: 'tiktok', handle: '@science' },
        { platform: 'x', handle: '@science' },
      ],
      proof: proofFor(creator, 'name:labs'),
    };
    const saved = await clientFor(url, 'pseudonym').json<CreatorInfo>('/v1/creators/accounts', { method: 'PUT', body: good });
    assert.deepEqual(
      saved.accounts?.map((account) => [account.platform, account.handle]),
      [
        ['yt', '@science'],
        ['tiktok', '@science'],
        ['x', '@science'],
      ]
    );
    // What the creator page shows.
    const view = await clientFor(url).json<{ creator: CreatorInfo }>('/v1/creators/name:labs', { auth: false });
    assert.equal(view.creator.accounts?.length, 3);
  });

  it('caps how many accounts one creator may link, at the number the operator sets', async () => {
    await admin(url, '/v1/admin/config', { method: 'PUT', body: { maxCreatorAccounts: 2 } });
    const tooMany: CreatorAccountLinkRequest = {
      creator: 'name:labs',
      accounts: [
        { platform: 'yt', handle: '@a' },
        { platform: 'x', handle: '@a' },
        { platform: 'tiktok', handle: '@a' },
      ],
      proof: proofFor(creator, 'name:labs'),
    };
    await assert.rejects(clientFor(url, 'pseudonym').json('/v1/creators/accounts', { method: 'PUT', body: tooMany }), /at most 2 accounts/);
    // The limit travels in the node info, where clients (and the GUI) can see it.
    const { info } = await clientFor(url).json<SignedInfo>('/v1/info', { auth: false });
    assert.equal((info as AlgorithmInfo).maxCreatorAccounts, 2);
    await admin(url, '/v1/admin/config', { method: 'PUT', body: { maxCreatorAccounts: 8 } });
  });

  it('lets a new creator start their record with their key as id', async () => {
    const fresh = generateIdentity();
    const request: CreatorAccountLinkRequest = {
      creator: fresh.id,
      name: 'Solo Rider',
      kind: 'person',
      accounts: [{ platform: 'x', handle: '@solo' }],
      proof: proofFor(fresh, fresh.id),
    };
    const saved = await clientFor(url, 'pseudonym').json<CreatorInfo>('/v1/creators/accounts', { method: 'PUT', body: request });
    assert.equal(saved.id, fresh.id);
    assert.equal(saved.name, 'Solo Rider');
    assert.equal(saved.accounts?.[0]?.handle, '@solo');
  });
});

describe('suggesting content related to a creator', async () => {
  const node = await startAlgorithm({ rewards: { acceptedSuggestion: 5 } });
  const url = node.url();
  after(() => node.stop());
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  const client = clientFor(url, 'pseudonym');

  it('takes the suggestion with its optional message; accepting pays the client', async () => {
    const first = await client.json<CreatorContentResponse>('/v1/creators/name:labs/suggestions', {
      body: { id: 'yt:newclip', message: 'This is their second channel' },
    });
    assert.equal(first.newInfo, true);
    assert.equal(first.credited, 0, 'credits come with the acceptance');
    assert.equal(first.suggestion.message, 'This is their second channel');
    assert.equal(first.suggestion.status, 'pending');

    const again = await client.json<CreatorContentResponse>('/v1/creators/name:labs/suggestions', { body: { id: 'yt:newclip' } });
    assert.equal(again.newInfo, false, 'the same content is not suggested twice');

    const pending = await admin<{ suggestions: { id: string; message?: string; creatorName?: string }[] }>(url, '/v1/admin/creator-suggestions');
    assert.equal(pending.suggestions.length, 1);
    assert.equal(pending.suggestions[0].message, 'This is their second channel');
    assert.equal(pending.suggestions[0].creatorName, 'Science Labs');
    await admin(url, `/v1/admin/creator-suggestions/${pending.suggestions[0].id}/accept`, { body: {} });

    const account = await client.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 105, 'the accepted suggestion paid 5 credits');
    const feed = await client.json<{ items: { id: string; creator?: { id: string } }[] }>('/v1/feed', { body: {}, auth: false });
    assert.ok(feed.items.some((item) => item.id === 'yt:newclip' && item.creator?.id === 'name:labs'), 'the content joined the creator');
  });

  it('deletes a suggestion the operator does not want; it can be suggested again', async () => {
    await client.json('/v1/creators/name:labs/suggestions', { body: { id: 'yt:spam' } });
    const pending = await admin<{ suggestions: { id: string; contentRef: string }[] }>(url, '/v1/admin/creator-suggestions');
    const spam = pending.suggestions.find((s) => s.contentRef === 'yt:spam')!;
    await admin(url, `/v1/admin/creator-suggestions/${spam.id}/delete`, { body: {} });
    const after = await admin<{ suggestions: unknown[] }>(url, '/v1/admin/creator-suggestions');
    assert.equal(after.suggestions.length, 0, 'deleted for good');
    const again = await client.json<CreatorContentResponse>('/v1/creators/name:labs/suggestions', { body: { id: 'yt:spam' } });
    assert.equal(again.newInfo, true, 'a deleted suggestion can be made again');
  });

  it('is also visible to the client among its own suggestions', async () => {
    const mine = await client.json<{ suggestions: { contentRef: string; status: string }[] }>('/v1/creator-suggestions/mine');
    assert.ok(mine.suggestions.some((s) => s.contentRef === 'yt:newclip' && s.status === 'accepted'));
    assert.ok(mine.suggestions.some((s) => s.contentRef === 'yt:spam' && s.status === 'pending'));
  });
});

describe('a client searching for creators', async () => {
  const { dir, cleanup } = tempDir();
  const algorithm = await startAlgorithm({ name: 'Curator' });
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    await algorithm.stop();
    cleanup();
  });

  await admin(algorithm.url(), '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  await admin(algorithm.url(), '/v1/admin/creators', { method: 'PUT', body: { id: 'name:solo', name: 'Solo Rider', kind: 'person' } });
  await api('/api/nodes', { body: { text: algorithm.reference() } });

  it('finds creators by name (Explore shows them next to the content results)', async () => {
    const found = await api<{ creators: CreatorInfo[] }>('/api/creators?q=labs');
    assert.deepEqual(
      found.creators.map((c) => c.id),
      ['name:labs']
    );
    const people = await api<{ creators: CreatorInfo[] }>('/api/creators?q=solo');
    assert.equal(people.creators[0]?.name, 'Solo Rider');
    const none = await api<{ creators: CreatorInfo[] }>('/api/creators?q=nobody-here');
    assert.deepEqual(none.creators, []);
  });
});
