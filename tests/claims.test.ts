// Claims: clients reporting platform popularity numbers (views, likes, comments,
// subscribers, upvotes…) to an algorithm node, and suggestions of missing data to both
// node types. Only new information pays, times the per-source credit multipliers.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ClaimResponse, ContentItem, LookupResult, ProviderSuggestionResponse } from '../src/shared/protocol.js';
import { admin, clientFor, randomBytesOf, startAlgorithm, startProvider } from './helpers.js';

describe('claims of platform numbers', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: 'yt:claim-video', title: 'A video', format: 'video' } });
  const client = clientFor(url);
  const now = () => new Date().toISOString();
  const claim = (metrics: Record<string, number>, publishedAt?: string) =>
    client.json<ClaimResponse>('/v1/claims', { body: { id: 'yt:claim-video', source: 'youtube', metrics, publishedAt } });

  it('pays base × multiplier for numbers the node did not have yet', async () => {
    // Defaults: 0.001 × views + 0.01 × likes + 0.001 × comments + 0.01 × subscribers,
    // times a recency factor of 5× for a brand-new post decaying to 1×.
    const first = await claim({ views: 1000, likes: 10 }, now());
    assert.equal(first.newInfo, true);
    assert.deepEqual(first.updated.sort(), ['likes', 'views']);
    assert.ok(Math.abs(first.multiplier - 5.5) < 0.01, `1.1 × 5, got ${first.multiplier}`);
    assert.equal(first.credited, 11, 'base 2 × 5.5');
  });

  it('pays nothing for numbers it already had', async () => {
    const again = await claim({ views: 1000, likes: 10 }, now());
    assert.equal(again.newInfo, false);
    assert.equal(again.credited, 0);
    assert.deepEqual(again.updated, []);
  });

  it('counts only higher numbers as new', async () => {
    const result = await claim({ views: 500, comments: 3 }, now());
    assert.deepEqual(result.updated, ['comments'], 'lower views are not new information');
    // 0.001 × 500 + 0.001 × 3 = 0.503, times 5 for a brand-new post.
    assert.ok(Math.abs(result.multiplier - 2.515) < 0.01, `got ${result.multiplier}`);
    assert.equal(result.credited, 5);
  });

  it('decays the recency factor to 1× and never goes below a 1× multiplier', async () => {
    const old = await client.json<ClaimResponse>('/v1/claims', {
      body: {
        id: 'ia:ancient-cartoon',
        source: 'archive',
        metrics: { views: 1 },
        publishedAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
      },
    });
    assert.equal(old.known, false, 'an unknown content is new information too');
    assert.equal(old.newInfo, true);
    assert.equal(old.multiplier, 1, 'the multiplier is never less than 1');
    assert.equal(old.credited, 2, 'base × 1');
  });

  it('lets the operator re-weight and switch off metrics per source', async () => {
    await admin(url, '/v1/admin/config', {
      method: 'PUT',
      body: {
        claims: {
          base: 10,
          sources: {
            youtube: {
              metrics: {
                views: { enabled: true, coefficient: 0.002 },
                likes: { enabled: false },
                comments: { enabled: false },
                subscribers: { enabled: false },
              },
              recency: { enabled: true, multiplier: 1, halfLifeDays: 30 },
            },
          },
        },
      },
    });
    const weighted = await claim({ views: 3000 }, now());
    assert.equal(weighted.newInfo, true);
    assert.equal(weighted.multiplier, 6, '0.002 × 3000, recency at 1×');
    assert.equal(weighted.credited, 60, 'base 10 × 6');
    const off = await claim({ likes: 99_999 }, now());
    assert.equal(off.newInfo, true, 'the number is kept even when its metric is off');
    assert.equal(off.multiplier, 1, 'a switched-off metric adds nothing');
    assert.equal(off.credited, 10);
  });

  it('refuses claims without numbers or from the future', async () => {
    await assert.rejects(client.json('/v1/claims', { body: { id: 'yt:claim-video', metrics: {} } }), /metrics is required/);
    await assert.rejects(
      client.json('/v1/claims', { body: { id: 'yt:claim-video', metrics: { views: 1 }, publishedAt: '2199-01-01' } }),
      /future/
    );
  });
});

describe('suggestions of sources and duplicates to the algorithm node', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: 'yt:sug-video', title: 'A video', format: 'video' } });
  const client = clientFor(url);

  it('adds accepted source links to the id (one id, several sources)', async () => {
    const suggestion = await client.json<{ status: string; value: string }>('/v1/suggestions', {
      body: {
        id: 'yt:sug-video',
        kind: 'source',
        value: 'https://www.twitch.tv/videos/123',
        platform: 'twitch',
        reason: 'the same video is on twitch',
      },
    });
    assert.equal(suggestion.value, 'twitch:v123', 'links are stored in their platform form');
    const pending = await admin<{ suggestions: { id: string; kind: string }[] }>(url, '/v1/admin/suggestions');
    const source = pending.suggestions.find((s) => s.kind === 'source')!;
    await admin(url, `/v1/admin/suggestions/${source.id}/accept`, { body: {} });
    const item = (await client.json<LookupResult>(`/v1/content/${encodeURIComponent('yt:sug-video')}`)) as ContentItem;
    assert.equal(item.id, 'yt:sug-video~twitch:v123');
    assert.equal(item.link, 'yt:sug-video');
  });

  it('keeps accepted duplicate reports as evidence', async () => {
    await client.json('/v1/suggestions', {
      body: { id: 'yt:sug-video', kind: 'duplicate', value: 'yt:the-other-one', reason: 'same video posted twice' },
    });
    const pending = await admin<{ suggestions: { id: string; kind: string }[] }>(url, '/v1/admin/suggestions');
    const duplicate = pending.suggestions.find((s) => s.kind === 'duplicate')!;
    await admin(url, `/v1/admin/suggestions/${duplicate.id}/accept`, { body: {} });
    const item = (await client.json<LookupResult>(`/v1/content/${encodeURIComponent('yt:sug-video')}`)) as ContentItem;
    assert.ok(item.notes?.some((note) => note.kind === 'duplicate' && note.value === 'yt:the-other-one'));
  });
});

describe('suggestions of missing data to the provider node', async () => {
  const provider = await startProvider();
  after(() => provider.stop());
  const { cid } = await provider.importBuffer(randomBytesOf(2048), { name: 'clip.bin', mime: 'application/octet-stream' });
  const client = clientFor(provider.url());

  it('rewards new suggestions once and applies accepted ones to the content', async () => {
    const body = {
      id: cid,
      kind: 'source',
      sources: [{ platform: 'youtube', url: 'https://www.youtube.com/watch?v=abc' }],
      note: 'this is the same video',
    };
    const first = await client.json<ProviderSuggestionResponse>('/v1/suggestions', { body });
    assert.equal(first.newInfo, true);
    assert.equal(first.credited, 1);
    const again = await client.json<ProviderSuggestionResponse>('/v1/suggestions', { body });
    assert.equal(again.newInfo, false, 'the same suggestion twice is not new information');
    assert.equal(again.credited, 0);

    const duplicateOf = 'vs1' + 'b'.repeat(52);
    const duplicate = await client.json<ProviderSuggestionResponse>('/v1/suggestions', {
      body: { id: cid, kind: 'duplicate', duplicateOf },
    });
    assert.equal(duplicate.newInfo, true);

    const mine = await client.json<{ suggestions: { id: string }[] }>('/v1/suggestions/mine');
    assert.equal(mine.suggestions.length, 2, 'clients can see what they suggested');

    const pending = await admin<{ suggestions: { id: string; kind: string }[] }>(provider.url(), '/v1/admin/suggestions');
    assert.equal(pending.suggestions.length, 2);
    for (const suggestion of pending.suggestions) {
      await admin(provider.url(), `/v1/admin/suggestions/${suggestion.id}/accept`, { body: {} });
    }
    const details = await admin<{ record: { sources?: string[]; duplicates?: string[] } }>(provider.url(), `/v1/admin/content/${cid}`);
    assert.ok(details.record.sources?.includes('https://www.youtube.com/watch?v=abc'));
    assert.ok(details.record.duplicates?.includes(duplicateOf));
    // The catalog now carries the extra sources of the content id.
    const catalog = await client.json<{ items: { cid: string; sources?: string[] }[] }>('/v1/catalog', { auth: false });
    const item = catalog.items.find((entry) => entry.cid === cid)!;
    assert.ok(item.sources?.includes('https://www.youtube.com/watch?v=abc'));
  });

  it('refuses suggestions without the data they need', async () => {
    await assert.rejects(client.json('/v1/suggestions', { body: { id: cid, kind: 'source', sources: [] } }), /source link/);
    await assert.rejects(client.json('/v1/suggestions', { body: { id: cid, kind: 'duplicate' } }), /duplicateOf/);
  });
});