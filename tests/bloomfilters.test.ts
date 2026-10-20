import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { BloomFilter, optimalHashCount } from '../src/shared/bloom.js';
import type { BloomStatus, ContentView, FeedResponse, NodeEntry, Settings } from '../src/shared/clientapi.js';
import type { AccountFilterState, AlgorithmInfo, BloomStorageState, ContentItem, Page, SignedInfo } from '../src/shared/protocol.js';
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

  await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: `${vid}~yt:black1`, title: 'Black holes', format: 'video', rating: 'all', creatorId: 'stars' } });
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

  it('still lists the newest content of followed creators: the subscriptions feed ignores seen filters', async () => {
    const client = clientFor(url);
    const latest = await client.json<Page<ContentItem>>('/v1/creators/latest', {
      body: { creators: ['stars'], bloom: seen.toJSON() },
      auth: false,
    });
    assert.ok(latest.items.some((item) => item.title === 'Black holes'), 'the newest content is listed there, seen or not');
  });

  it('refuses filters that are too big or do not use the optimal hash count', async () => {
    const client = clientFor(url);
    const big = new BloomFilter(2_048);
    big.add(vid);
    await assert.rejects(client.json('/v1/search', { body: { query: 'holes', bloom: big.toJSON() }, auth: false }), /at most 1024 bits/);
    const wrongK = { ...seen.toJSON(), k: 99 };
    await assert.rejects(client.json('/v1/search', { body: { query: 'holes', bloom: wrongK }, auth: false }), /hash functions/);
    // The hash count must match the number of items the filter declares it is made for.
    const wrongN = { ...seen.toJSON(), n: 10 };
    await assert.rejects(client.json('/v1/search', { body: { query: 'holes', bloom: wrongN }, auth: false }), /hash functions/);
  });

  it('keeps an account filter long term (never in requests), and refuses one bigger than its cap', async () => {
    const account = clientFor(url, 'pseudonym');
    const filter = new BloomFilter(1_024);
    filter.add(vid);
    const kept = await account.json<AccountFilterState>('/v1/account-filter', { method: 'PUT', body: { filter: filter.toJSON() } });
    assert.ok(kept.updatedAt, 'the node says when the account filter was last updated');
    assert.equal(kept.maxBits, 1_048_576, 'and how big a filter it keeps for an account');
    // No request carries it — the node applies the copy it keeps while searching.
    const hidden = await account.json<Page<ContentItem>>('/v1/search', { body: { query: 'holes' } });
    assert.ok(!hidden.items.some((item) => item.title === 'Black holes'));
    const tooBig = new BloomFilter(2_097_152);
    tooBig.add(vid);
    await assert.rejects(account.json('/v1/account-filter', { method: 'PUT', body: { filter: tooBig.toJSON() } }), /at most \d+ bits/);
    await account.json('/v1/account-filter', { method: 'DELETE' });
    assert.equal((await account.json<AccountFilterState>('/v1/account-filter')).filter, undefined);
    const back = await account.json<Page<ContentItem>>('/v1/search', { body: { query: 'holes' } });
    assert.ok(back.items.some((item) => item.title === 'Black holes'), 'gone once it is dropped');
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

  it('shows the operator every stored filter, and drops one on request', async () => {
    const account = clientFor(url, 'pseudonym');
    await account.json('/v1/bloom', { method: 'PUT', body: { tier: 'tiny', filter: seen.toJSON() } });
    const listed = await admin<{ stored: { account: string; bits: number; expected: number; hashes: number; expiresAt: string }[] }>(url, '/v1/admin/bloom');
    assert.equal(listed.stored.length, 1, 'expired copies are swept up while listing');
    const entry = listed.stored[0];
    assert.equal(entry.bits, 1_024);
    assert.ok(entry.hashes >= 1);
    assert.ok(Date.parse(entry.expiresAt) > Date.now(), 'the operator sees how long it is kept');

    await admin(url, `/v1/admin/bloom/${encodeURIComponent(entry.account)}`, { method: 'DELETE' });
    const after = await admin<{ stored: unknown[] }>(url, '/v1/admin/bloom');
    assert.deepEqual(after.stored, [], 'gone once the operator dropped it');
    assert.equal((await account.json<BloomStorageState>('/v1/bloom')).filter, undefined, 'the client is told its copy is gone');
  });

  it('lets the operator change the time periods and credits of filter storage', async () => {
    const before = await admin<{ bloom: { inlineMaxBits: number } }>(url, '/v1/admin/config');
    await admin(url, '/v1/admin/config', {
      method: 'PUT',
      body: { bloom: { storage: { tiers: [{ id: 'test', label: 'Test', maxBits: 2_048, durationSeconds: 60, price: 7 }] } } },
    });
    const config = await admin<{ bloom: { inlineMaxBits: number; storage: { tiers: { id: string; durationSeconds: number; price: number }[] } } }>(
      url,
      '/v1/admin/config'
    );
    assert.deepEqual(
      config.bloom.storage.tiers.map((tier) => [tier.id, tier.durationSeconds, tier.price]),
      [['test', 60, 7]]
    );
    assert.equal(config.bloom.inlineMaxBits, before.bloom.inlineMaxBits, 'the rest of the settings stay as they were');
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

  it('has the four filters in its settings, with their defaults and their own ranges', async () => {
    const { settings } = await api<{ settings: Settings }>('/api/state');
    assert.deepEqual(settings.selectedBloom, { enabled: true, bits: 10_000, expected: 10_000 });
    assert.deepEqual(settings.previewBloom, { enabled: true, bits: 100_000, expected: 10_000 });
    assert.deepEqual(settings.searchBloom, { enabled: false, bits: 10_000, expected: 10_000 });
    assert.deepEqual(settings.accountBloom, { enabled: false, bits: 1_000_000, expected: 10_000, resubmitHours: 24 }, 'the account filter resubmits every day by default');
    assert.equal(settings.seenContentMode, 'hide', 'seen content is eliminated from the results by default');

    // The slider stops snap to 1, 10, 100, … bits within each range.
    const saved = await api<Settings>('/api/settings', {
      method: 'PATCH',
      body: { selectedBloom: { enabled: true, bits: 12_345 }, previewBloom: { enabled: true, bits: 1_000_000_000_000 } },
    });
    assert.equal(saved.selectedBloom.bits, 10_000);
    assert.equal(saved.previewBloom.bits, 1_000_000_000, 'the preview filter goes up to 1,000,000,000 bits');
    await assert.rejects(api('/api/settings', { method: 'PATCH', body: { selectedBloom: { enabled: true, bits: 0 } } }), /400/);
    await assert.rejects(api('/api/settings', { method: 'PATCH', body: { seenContentMode: 'shuffle' } }), /400/);

    // The number of items a filter is made for is configurable too (it sets the hashes).
    const tuned = await api<Settings>('/api/settings', { method: 'PATCH', body: { selectedBloom: { enabled: true, bits: 10_000, expected: 2500.4 } } });
    assert.equal(tuned.selectedBloom.expected, 2500);
    const status = await api<BloomStatus>('/api/bloom');
    assert.equal(status.selected.hashes, optimalHashCount(10_000, 2500));
    await assert.rejects(api('/api/settings', { method: 'PATCH', body: { selectedBloom: { enabled: true, bits: 10_000, expected: 0 } } }), /400/);
    await api('/api/settings', { method: 'PATCH', body: { selectedBloom: { enabled: true, bits: 10_000, expected: 10_000 } } });
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
    await api('/api/bloom/reset', { body: { scope: 'selected' } });
    await api('/api/bloom/reset', { body: { scope: 'preview' } });
    const all = await browse();
    const target = all.items[0];
    assert.ok(!target.seen, 'nothing is guessed watched before it was seen');
    await api('/api/bloom/mark', { body: { scope: 'preview', id: target.id, contentId: target.contentId, link: target.link } });

    // Opening it the first time shows no "*watched": it is watched from the second time
    // on, and this is the first. A preview is not a watch.
    const first = await api<ContentView>(`/api/content/${encodeURIComponent(target.id)}`);
    assert.ok(!first.seen, 'the first open does not show the watched guess');

    const hidden = await browse();
    assert.ok(!hidden.items.some((item) => item.id === target.id), 'hidden completely by default');

    await api('/api/settings', { method: 'PATCH', body: { seenContentMode: 'rank' } });
    const demoted = await browse();
    assert.ok(demoted.items.some((item) => item.id === target.id), 'still shown when only the ranking is altered');
    assert.equal(demoted.items.at(-1)!.id, target.id, 'but pushed below everything the user has not seen');
    assert.ok(!demoted.items.at(-1)!.seen, 'still no watched mark on content that was only previewed');

    // Once it has been opened, this and any later time shows it as watched.
    await api('/api/history', { body: { id: target.id, title: target.title, contentId: target.contentId, link: target.link } });
    const again = await api<ContentView>(`/api/content/${encodeURIComponent(target.id)}`);
    assert.equal(again.seen, true, 'the second open shows the watched guess');
    const listed = await browse();
    assert.equal(listed.items.at(-1)?.id, target.id, 'still demoted');
    assert.equal(listed.items.at(-1)?.seen, true, 'and the feeds mark it watched from then on');
  });

  it('resets a filter behind a warning, forgetting everything it held', async () => {
    await api('/api/settings', { method: 'PATCH', body: { seenContentMode: 'hide' } });
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

  it('sends the search filter with search requests, and the node stops suggesting what it has seen', async () => {
    await api('/api/settings', {
      method: 'PATCH',
      body: {
        selectedBloom: { enabled: false, bits: 10_000 },
        previewBloom: { enabled: false, bits: 100_000 },
        searchBloom: { enabled: true, bits: 10_000, expected: 10_000 },
      },
    });
    await api('/api/bloom/reset', { body: { scope: 'search' } });
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
    await api('/api/settings', { method: 'PATCH', body: { searchBloom: { enabled: false, bits: 10_000 } } });
    const still = await api<FeedResponse>('/api/search', { body: { query: 'flow' } });
    assert.ok(!still.items.some((item) => item.id === 'yt:lava2'), 'the stored filter is applied too');

    await api(`/api/bloom/storage/${entry.id}`, { method: 'DELETE' });
    const back = await api<FeedResponse>('/api/search', { body: { query: 'flow' } });
    assert.ok(back.items.some((item) => item.id === 'yt:lava2'), 'gone from the node: suggested again');

    // A filter bigger than every tier is refused.
    await api('/api/settings', { method: 'PATCH', body: { searchBloom: { enabled: true, bits: 1_000_000, expected: 10_000 } } });
    await assert.rejects(api(`/api/bloom/storage/${entry.id}`, { body: { tier: 'day' } }), /at most \d+ bits/);
    await api('/api/settings', { method: 'PATCH', body: { searchBloom: { enabled: false, bits: 10_000 } } });
  });

  it('pauses the whole history: viewing leaves no trace until it is back on', async () => {
    await api('/api/settings', {
      method: 'PATCH',
      body: {
        pauseHistory: true,
        selectedBloom: { enabled: true, bits: 10_000, expected: 10_000 },
        previewBloom: { enabled: true, bits: 100_000, expected: 10_000 },
        searchBloom: { enabled: true, bits: 10_000, expected: 10_000 },
        accountBloom: { enabled: true, bits: 10_000, expected: 10_000, resubmitHours: 0 },
      },
    });
    const before = await api<BloomStatus>('/api/bloom');

    // Viewing content now records nothing — neither history nor any of the filters.
    await api('/api/history', { body: { id: 'yt:goat3', title: 'Mountain goat jumps' } });
    await api('/api/bloom/mark', { body: { scope: 'preview', id: 'yt:goat3' } });
    const library = await api<{ history: { id: string }[] }>('/api/library');
    assert.ok(!library.history.some((h) => h.id === 'yt:goat3'), 'the history stands still');
    const paused = await api<BloomStatus>('/api/bloom');
    assert.equal(paused.selected.added, before.selected.added, 'no filter recorded anything');
    assert.equal(paused.preview.added, before.preview.added);
    assert.equal(paused.search.added, before.search.added);
    assert.equal(paused.account.added, before.account.added);

    // Back on, the same views count again.
    await api('/api/settings', { method: 'PATCH', body: { pauseHistory: false } });
    await api('/api/history', { body: { id: 'yt:goat3', title: 'Mountain goat jumps' } });
    const library2 = await api<{ history: { id: string }[] }>('/api/library');
    assert.equal(library2.history[0]?.id, 'yt:goat3');
    const done = await api<BloomStatus>('/api/bloom');
    assert.ok(done.selected.added > before.selected.added, 'and recording works again');
  });

  it('keeps the much larger account filter on the node, separate from the search filter', async () => {
    const { nodes } = await api<{ nodes: NodeEntry[] }>('/api/state');
    const entry = nodes.find((node) => node.type === 'algorithm')!;
    const start = await api<FeedResponse>('/api/search', { body: { query: 'flow' } });
    const offersBefore = await api<BloomStorageState>(`/api/bloom/offers/${entry.id}`);
    // The account filter alone: the search filter is off, so nothing travels in requests.
    await api('/api/settings', {
      method: 'PATCH',
      body: {
        selectedBloom: { enabled: false, bits: 10_000 },
        previewBloom: { enabled: false, bits: 100_000 },
        searchBloom: { enabled: false, bits: 10_000 },
        accountBloom: { enabled: true, bits: 10_000, expected: 10_000, resubmitHours: 0 },
      },
    });
    await api('/api/bloom/reset', { body: { scope: 'account' } });
    await api('/api/bloom/mark', { body: { scope: 'preview', id: 'yt:lava2', title: 'Lava flow' } });

    // The button: the account filter goes to every search node at once.
    const submitted = await api<{ results: { node: string; ok: boolean }[] }>('/api/bloom/account', { method: 'POST' });
    assert.equal(submitted.results.length, 1);
    assert.equal(submitted.results[0].ok, true);
    const kept = await api<AccountFilterState>(`/api/bloom/account/${entry.id}`);
    assert.ok(kept.filter, 'the node keeps it');
    assert.ok(Date.parse(kept.updatedAt!) > Date.now() - 60_000, 'and says when it was last updated');
    assert.equal(kept.maxBits, 1_048_576, 'the node says how big a filter it keeps for an account');

    // No request carries it — yet the node stops suggesting what it holds.
    const hidden = await api<FeedResponse>('/api/search', { body: { query: 'flow' } });
    assert.ok(!hidden.items.some((item) => item.id === 'yt:lava2'), 'the stored account filter is applied while searching');

    // Dropping it on the node brings the content back.
    await api(`/api/bloom/account/${entry.id}`, { method: 'DELETE' });
    assert.equal((await api<AccountFilterState>(`/api/bloom/account/${entry.id}`)).filter, undefined);
    const back = await api<FeedResponse>('/api/search', { body: { query: 'flow' } });
    const raw = await clientFor(algorithm.url(), 'pseudonym').json<Page<ContentItem>>('/v1/search', { body: { query: 'flow' } });
    const live = await api<{ settings: Settings }>('/api/state');
    const again = await api<AccountFilterState>(`/api/bloom/account/${entry.id}`);
    assert.ok(
      back.items.some((item) => item.id === 'yt:lava2'),
      `suggested again — the client saw: ${JSON.stringify(back).slice(0, 600)}; the node serves: ${raw.items
        .map((i) => i.id)
        .join(', ') || '(none)'}; selected: ${JSON.stringify(
        live.settings.selectedBloom
      )}; preview: ${JSON.stringify(live.settings.previewBloom)}; search: ${JSON.stringify(live.settings.searchBloom)}; account: ${JSON.stringify(
        live.settings.accountBloom
      )}; node keeps: ${again.filter ? 'a filter' : 'nothing'}; paid: ${
        (await api<BloomStorageState>(`/api/bloom/offers/${entry.id}`)).filter ? 'a copy' : 'nothing'
      }; at start: ${start.items.map((i) => i.id).join(', ') || '(none)'} (paid then: ${offersBefore.filter ? 'a copy' : 'nothing'})`
    );
  });

  it('resubmits the account filter on its own — every day by default, off or on a schedule', async () => {
    const { nodes } = await api<{ nodes: NodeEntry[] }>('/api/state');
    const entry = nodes.find((node) => node.type === 'algorithm')!;

    // Switched off: nothing is submitted by itself.
    await api(`/api/bloom/account/${entry.id}`, { method: 'DELETE' });
    await api('/api/settings', { method: 'PATCH', body: { accountBloom: { enabled: true, bits: 10_000, expected: 10_000, resubmitHours: 0 } } });
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal((await api<AccountFilterState>(`/api/bloom/account/${entry.id}`)).filter, undefined, 'the job is off — only the button submits');

    // A short interval stands in for the daily default: the job resubmits on its own.
    await api('/api/settings', { method: 'PATCH', body: { accountBloom: { enabled: true, bits: 10_000, expected: 10_000, resubmitHours: 0.0003 } } });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const kept = await api<AccountFilterState>(`/api/bloom/account/${entry.id}`);
    assert.ok(kept.filter, 'the job submitted the account filter by itself');
    assert.ok(Date.parse(kept.updatedAt!) > Date.now() - 60_000);

    await api('/api/settings', { method: 'PATCH', body: { accountBloom: { enabled: true, bits: 10_000, expected: 10_000, resubmitHours: 0 } } });
    await api(`/api/bloom/account/${entry.id}`, { method: 'DELETE' });
  });
});
