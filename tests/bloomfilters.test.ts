import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { BloomFilter, optimalHashCount } from '../src/shared/bloom.js';
import type { BloomStatus, FeedResponse, NodeEntry, Settings } from '../src/shared/clientapi.js';
import type { AlgorithmInfo, BloomStorageState, ContentItem, Page, SignedInfo } from '../src/shared/protocol.js';
import { admin, clientFor, startAlgorithm, startClient, tempDir } from './helpers.js';

const vid = 'vs1' + 'a'.repeat(52);

describe('a search node filtering content the user has seen', async () => {
  const node = await startAlgorithm({
    bloom: {
      inlineMaxBits: 1_024,
      storage: {
        tiers: [
          { id: 'tiny', maxBits: 1_024, durationSeconds: 3600, price: 3 },
          { id: 'gone', maxBits: 1_024, durationSeconds: 0, price: 1 },
        ],
      },
    },
  });
  const url = node.url();
  after(() => node.stop());

  await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: `${vid}~yt:black1`, title: 'Black holes', format: 'video', rating: 'all' } });
  await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: 'yt:lava2', title: 'Lava flow', format: 'video', rating: 'all' } });

  const seen = new BloomFilter(1_024);
  seen.addContent({ id: `${vid}~yt:black1`, contentId: vid, link: 'yt:black1' });

  it('advertises its filter service: the tiers it sells and the request size it accepts', async () => {
    const { info } = await clientFor(url).json<SignedInfo>('/v1/info', { auth: false });
    const bloom = (info as AlgorithmInfo).bloom;
    assert.ok(bloom, 'the node says it takes seen-content filters');
    assert.equal(bloom.inlineMaxBits, 1_024);
    assert.deepEqual(
      bloom.storage.tiers.map((tier) => [tier.id, tier.price]),
      [
        ['tiny', 3],
        ['gone', 1],
      ]
    );
  });

  it('does not suggest content whose cid or links collide with a filter sent along', async () => {
    const client = clientFor(url);
    const before = await client.json<Page<ContentItem>>('/v1/search', { body: { query: 'holes' }, auth: false });
    assert.ok(before.items.some((item) => item.title === 'Black holes'));

    // The whole filter, the cid alone and the link alone each hide the content.
    const cidOnly = new BloomFilter(1_024);
    cidOnly.add(vid);
    const linkOnly = new BloomFilter(1_024);
    linkOnly.add('yt:black1');
    for (const filter of [seen, cidOnly, linkOnly]) {
      const after = await client.json<Page<ContentItem>>('/v1/search', { body: { query: 'holes', bloom: filter.toJSON() }, auth: false });
      assert.ok(!after.items.some((item) => item.title === 'Black holes'), 'not suggested at all');
      assert.ok(after.items.every((item) => item.id !== `${vid}~yt:black1`));
    }
    // Feeds filter the same way.
    const feed = await client.json<Page<ContentItem>>('/v1/feed', { body: { bloom: seen.toJSON() }, auth: false });
    assert.ok(!feed.items.some((item) => item.title === 'Black holes'));
    assert.ok(feed.items.some((item) => item.title === 'Lava flow'), 'the rest is still suggested');
  });

  it('refuses filters that are too big or do not use the optimal hash count', async () => {
    const client = clientFor(url);
    const big = new BloomFilter(2_048);
    big.add(vid);
    await assert.rejects(client.json('/v1/search', { body: { query: 'holes', bloom: big.toJSON() }, auth: false }), /at most 1024 bits/);
    const wrongK = { ...seen.toJSON(), k: 99 };
    await assert.rejects(client.json('/v1/search', { body: { query: 'holes', bloom: wrongK }, auth: false }), /hash functions/);
  });

  it('keeps a paid copy of the filter for as long as its tier says, and drops it when asked', async () => {
    const account = clientFor(url, 'pseudonym');
    const offers = await account.json<BloomStorageState>('/v1/bloom');
    assert.equal(offers.filter, undefined);
    assert.deepEqual(
      offers.tiers.map((tier) => tier.id),
      ['tiny', 'gone']
    );

    const stored = await account.json<BloomStorageState>('/v1/bloom', { method: 'PUT', body: { tier: 'tiny', filter: seen.toJSON() } });
    assert.ok(stored.expiresAt, 'the node says how long it keeps it');
    assert.ok(Date.parse(stored.expiresAt) > Date.now() + 30 * 60_000, 'the tiny tier lasts an hour');
    const view = await account.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(view.account.balance, 97, 'the tier cost 3 of the 100 credits of a new account');

    // The stored copy is applied to suggestions of this account, no filter needed in the request.
    const hidden = await account.json<Page<ContentItem>>('/v1/search', { body: { query: 'holes' } });
    assert.ok(!hidden.items.some((item) => item.title === 'Black holes'));
    // Other accounts are unaffected.
    const other = await clientFor(url, 'pseudonym').json<Page<ContentItem>>('/v1/search', { body: { query: 'holes' } });
    assert.ok(other.items.some((item) => item.title === 'Black holes'));

    await account.json('/v1/bloom', { method: 'DELETE' });
    assert.equal((await account.json<BloomStorageState>('/v1/bloom')).filter, undefined);
    const back = await account.json<Page<ContentItem>>('/v1/search', { body: { query: 'holes' } });
    assert.ok(back.items.some((item) => item.title === 'Black holes'), 'suggested again once the copy is gone');
  });

  it('stops applying a stored filter once its time is up', async () => {
    const account = clientFor(url, 'pseudonym');
    await account.json('/v1/bloom', { method: 'PUT', body: { tier: 'gone', filter: seen.toJSON() } });
    const offers = await account.json<BloomStorageState>('/v1/bloom');
    assert.equal(offers.filter, undefined, 'a tier of zero seconds expires at once');
    const back = await account.json<Page<ContentItem>>('/v1/search', { body: { query: 'holes' } });
    assert.ok(back.items.some((item) => item.title === 'Black holes'));
  });
});

describe('a client keeping track of what the user has seen', async () => {
  const { dir, cleanup } = tempDir();
  const algorithm = await startAlgorithm({ name: 'Curator' });
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    await algorithm.stop();
    cleanup();
  });

  await admin(algorithm.url(), '/v1/admin/content', { method: 'PUT', body: { id: `${vid}~yt:black1`, title: 'Black holes', format: 'video', rating: 'all' } });
  await admin(algorithm.url(), '/v1/admin/content', { method: 'PUT', body: { id: 'yt:lava2', title: 'Lava flow', format: 'video', rating: 'all' } });
  await admin(algorithm.url(), '/v1/admin/content', { method: 'PUT', body: { id: 'yt:goat3', title: 'Mountain goat jumps', format: 'video', rating: 'all' } });
  await api('/api/nodes', { body: { text: algorithm.reference() } });

  const browse = () => api<FeedResponse>('/api/browse', { body: { source: 'feed' } });

  it('has the three filters in its settings, with their defaults and their own ranges', async () => {
    const { settings } = await api<{ settings: Settings }>('/api/state');
    assert.deepEqual(settings.selectedBloom, { enabled: true, bits: 10_000 });
    assert.deepEqual(settings.previewBloom, { enabled: true, bits: 100_000, mode: 'hide' });
    assert.deepEqual(settings.nodeBloom, { enabled: false, bits: 10_000, inline: true });

    // The slider stops snap to 1, 10, 100, … bits within each range.
    const saved = await api<Settings>('/api/settings', {
      method: 'PATCH',
      body: { selectedBloom: { enabled: true, bits: 12_345 }, previewBloom: { enabled: true, bits: 1_000_000_000_000, mode: 'hide' } },
    });
    assert.equal(saved.selectedBloom.bits, 10_000);
    assert.equal(saved.previewBloom.bits, 1_000_000_000, 'the preview filter goes up to 1,000,000,000 bits');
    await assert.rejects(api('/api/settings', { method: 'PATCH', body: { selectedBloom: { enabled: true, bits: 0 } } }), /400/);
    await assert.rejects(api('/api/settings', { method: 'PATCH', body: { previewBloom: { enabled: true, bits: 100, mode: 'shuffle' } } }), /400/);
    await api('/api/settings', { method: 'PATCH', body: { previewBloom: { enabled: true, bits: 100_000, mode: 'hide' } } });
  });

  it('records what the user selected — the cid and each link — and stops showing it', async () => {
    assert.ok((await browse()).items.some((item) => item.id.startsWith(vid)));
    await api('/api/history', { body: { id: `${vid}~yt:black1`, title: 'Black holes', contentId: vid, link: 'yt:black1' } });
    const status = await api<BloomStatus>('/api/bloom');
    assert.ok(status.selected.added >= 2, 'the cid and the link were added independently');
    const after = await browse();
    assert.ok(!after.items.some((item) => item.id.startsWith(vid)), 'what was opened is not suggested again');
    assert.ok(after.items.length >= 2, 'the rest is untouched');
  });

  it('remembers previews it saw on screen: hiding them, or only pushing them down', async () => {
    const all = await browse();
    const target = all.items[0];
    await api('/api/bloom/mark', { body: { scope: 'preview', id: target.id, contentId: target.contentId, link: target.link } });
    const hidden = await browse();
    assert.ok(!hidden.items.some((item) => item.id === target.id), 'hidden completely by default');

    await api('/api/settings', { method: 'PATCH', body: { previewBloom: { enabled: true, bits: 100_000, mode: 'demote' } } });
    const demoted = await browse();
    assert.ok(demoted.items.some((item) => item.id === target.id), 'still shown in demote mode');
    assert.equal(demoted.items.at(-1)!.id, target.id, 'but last of the previews');
    assert.equal(demoted.items.at(-1)!.seen, true, 'and marked as seen');
  });

  it('resets a filter behind a warning, forgetting everything it held', async () => {
    await api('/api/settings', { method: 'PATCH', body: { previewBloom: { enabled: true, bits: 100_000, mode: 'hide' } } });
    const before = await api<BloomStatus>('/api/bloom');
    assert.ok(before.preview.added > 0);
    const after = await api<BloomStatus>('/api/bloom/reset', { body: { scope: 'preview' } });
    assert.equal(after.preview.added, 0);
    const listed = await browse();
    assert.ok(listed.items.every((item) => !item.seen), 'nothing is seen anymore');
  });

  it('clears a filter when its size changes on the exponential slider', async () => {
    await api('/api/history', { body: { id: 'yt:lava2', title: 'Lava flow' } });
    assert.ok((await api<BloomStatus>('/api/bloom')).selected.added > 0);
    const resized = await api<Settings>('/api/settings', { method: 'PATCH', body: { selectedBloom: { enabled: true, bits: 1_000_000 } } });
    assert.equal(resized.selectedBloom.bits, 1_000_000);
    const status = await api<BloomStatus>('/api/bloom');
    assert.equal(status.selected.bits, 1_000_000);
    assert.equal(status.selected.hashes, optimalHashCount(1_000_000));
    assert.equal(status.selected.added, 0, 'a new size starts empty');
    const capped = await api<Settings>('/api/settings', { method: 'PATCH', body: { selectedBloom: { enabled: true, bits: 1_000_000_000 } } });
    assert.equal(capped.selectedBloom.bits, 100_000_000, 'the selected filter stops at 100,000,000 bits');
    await api('/api/settings', { method: 'PATCH', body: { selectedBloom: { enabled: false, bits: 10_000 } } });
  });

  it('sends the filter to the search node, which then stops suggesting what it has seen', async () => {
    await api('/api/settings', {
      method: 'PATCH',
      body: {
        selectedBloom: { enabled: false, bits: 10_000 },
        previewBloom: { enabled: false, bits: 100_000, mode: 'hide' },
        nodeBloom: { enabled: true, bits: 10_000, inline: true },
      },
    });
    await api('/api/bloom/reset', { body: { scope: 'node' } });
    const first = await api<FeedResponse>('/api/search', { body: { query: 'flow' } });
    const target = first.items.find((item) => item.id === 'yt:lava2');
    assert.ok(target, 'the content is suggested before the node knows anything');
    await api('/api/bloom/mark', { body: { scope: 'preview', id: target.id, contentId: target.contentId, link: target.link } });
    const after = await api<FeedResponse>('/api/search', { body: { query: 'flow' } });
    assert.ok(!after.items.some((item) => item.id === 'yt:lava2'), 'the node leaves out what collides with the filter it was sent');
  });

  it('can pay a search node to keep the filter, and drop it again', async () => {
    const { nodes } = await api<{ nodes: NodeEntry[] }>('/api/state');
    const entry = nodes.find((node) => node.type === 'algorithm')!;
    const offers = await api<BloomStorageState>(`/api/bloom/offers/${entry.id}`);
    assert.deepEqual(
      offers.tiers.map((tier) => tier.id),
      ['day', 'week', 'month'],
      'each node prices its own storage'
    );

    const stored = await api<BloomStorageState>(`/api/bloom/storage/${entry.id}`, { body: { tier: 'day' } });
    assert.ok(Date.parse(stored.expiresAt!) > Date.now(), 'the node keeps it until the tier runs out');
    const account = await api<{ account: { balance: number } }>(`/api/nodes/${entry.id}/account`);
    assert.equal(account.account.balance, 99, 'the day tier costs 1 of the 100 credits the account started with');

    // Without the request copy, the stored one still filters.
    await api('/api/settings', { method: 'PATCH', body: { nodeBloom: { enabled: true, bits: 10_000, inline: false } } });
    const still = await api<FeedResponse>('/api/search', { body: { query: 'flow' } });
    assert.ok(!still.items.some((item) => item.id === 'yt:lava2'), 'the stored filter is applied too');

    await api(`/api/bloom/storage/${entry.id}`, { method: 'DELETE' });
    const back = await api<FeedResponse>('/api/search', { body: { query: 'flow' } });
    assert.ok(back.items.some((item) => item.id === 'yt:lava2'), 'gone from the node: suggested again');

    // A filter bigger than every tier is refused.
    await api('/api/settings', { method: 'PATCH', body: { nodeBloom: { enabled: true, bits: 1_000_000, inline: true } } });
    await assert.rejects(api(`/api/bloom/storage/${entry.id}`, { body: { tier: 'day' } }), /at most \d+ bits/);
  });
});
