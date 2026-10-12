import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { generateIdentity, signData } from '../src/shared/crypto.js';
import { claimSigningPayload, type ContentItem, type LookupResult, type Page } from '../src/shared/protocol.js';
import { ADMIN, admin, clientFor, startAlgorithm, tempDir, waitFor } from './helpers.js';

const HOUR = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

describe('algorithm node', async () => {
  const node = await startAlgorithm({ rewards: { vote: 2, voteDailyCap: 1, acceptedSuggestion: 5, autoAcceptAgreement: 2 } });
  const url = node.url();
  after(() => node.stop());

  const vid = 'vs1' + 'a'.repeat(52);
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  const seed = [
    { id: `${vid}~yt:abc123`, title: 'How black holes work', format: 'video', rating: 'all', topics: ['science'], tags: ['space', 'physics'], creatorId: 'name:labs', publishedAt: ago(2) },
    { id: 'yt:music1', title: 'Lo-fi beats to study to', format: 'music', rating: 'all', topics: ['music'], tags: ['lofi'], publishedAt: ago(30) },
    { id: 'vimeo:42', title: 'Horror short film', format: 'short-video', rating: '18+', topics: ['film'], tags: ['horror'], publishedAt: ago(5) },
    { id: 'ia:old-cartoon', title: 'Old cartoon', format: 'video', rating: 'all', topics: ['kids'], tags: ['animation'], publishedAt: ago(500) },
    { id: 'x:999', title: 'Spam post', format: 'other', status: 'blocked', reason: 'spam' },
  ];
  for (const item of seed) await admin(url, '/v1/admin/content', { method: 'PUT', body: item });

  it('marks ids it has not set as unknown and blocked ids as blocked', async () => {
    const client = clientFor(url);
    const { items } = await client.json<{ items: LookupResult[] }>('/v1/lookup', { body: { ids: [vid, 'x:999', 'yt:never'] }, auth: false });
    assert.equal(items[0].status, 'listed');
    assert.equal((items[0] as ContentItem).id, `${vid}~yt:abc123`, 'fallback sources travel with the id');
    assert.equal((items[0] as ContentItem).contentId, vid, 'the content id is kept separately');
    assert.equal((items[0] as ContentItem).link, 'yt:abc123', 'as is the link');
    assert.equal((items[0] as ContentItem).creator?.kind, 'company');
    assert.equal(items[1].status, 'blocked');
    assert.equal(items[2].status, 'unknown');
    const external = await client.json<LookupResult>('/v1/content/yt:music1');
    assert.equal((external as ContentItem).contentId, undefined, 'external-only content has no content id');
    assert.equal((external as ContentItem).link, 'yt:music1');
  });

  it('filters the feed by preferences', async () => {
    const client = clientFor(url);
    const all = await client.json<Page<ContentItem>>('/v1/feed', { body: {}, auth: false });
    assert.equal(all.items.length, 4);
    const family = await client.json<Page<ContentItem>>('/v1/feed', { body: { preferences: { maxRating: '13+' } }, auth: false });
    assert.ok(!family.items.some((item) => item.rating === '18+'));
    const videos = await client.json<Page<ContentItem>>('/v1/feed', {
      body: { preferences: { formats: ['video'], blockedTags: ['animation'] } },
      auth: false,
    });
    assert.deepEqual(videos.items.map((item) => item.title), ['How black holes work']);
    const companies = await client.json<Page<ContentItem>>('/v1/feed', { body: { preferences: { creatorKinds: ['company'] } }, auth: false });
    assert.equal(companies.items.length, 1);
    const paged = await client.json<Page<ContentItem>>('/v1/feed', { body: { limit: 3, seed: 's' }, auth: false });
    assert.equal(paged.items.length, 3);
    const next = await client.json<Page<ContentItem>>('/v1/feed', { body: { limit: 3, seed: 's', cursor: paged.cursor }, auth: false });
    assert.equal(next.items.length, 1);
    assert.ok(!paged.items.some((item) => item.id === next.items[0].id));
  });

  it('searches titles, tags, creators and filters', async () => {
    const client = clientFor(url);
    const search = (query: string) => client.json<Page<ContentItem>>('/v1/search', { body: { query }, auth: false });
    assert.equal((await search('black holes')).items[0].title, 'How black holes work');
    assert.equal((await search('#lofi')).items[0].title, 'Lo-fi beats to study to');
    assert.equal((await search('@science')).items.length, 1);
    assert.equal((await search('format:music')).items.length, 1);
    assert.equal((await search('spam')).items.length, 0, 'blocked content never shows up');
  });

  it('rewards the first vote, up to the daily cap', async () => {
    const voter = clientFor(url, 'pseudonym');
    const first = await voter.json<{ likes: number; credited: number }>('/v1/votes', { body: { id: vid, vote: 1 } });
    assert.deepEqual([first.likes, first.credited], [1, 2]);
    const again = await voter.json<{ likes: number; credited: number }>('/v1/votes', { body: { id: vid, vote: -1 } });
    assert.equal(again.credited, 0);
    assert.equal(again.likes, 0);
    const capped = await voter.json<{ credited: number }>('/v1/votes', { body: { id: 'yt:music1', vote: 1 } });
    assert.equal(capped.credited, 0, 'daily cap reached');
  });

  it('accepts a tag once enough accounts agree, keeping the evidence', async () => {
    const a = clientFor(url);
    const b = clientFor(url);
    const body = { id: 'vimeo:42', kind: 'tag', value: 'Jump Scares', reason: 'Loud jump scare', timestamp: 63.4 };
    const first = await a.json<{ status: string; agreeing: number }>('/v1/suggestions', { body });
    assert.equal(first.status, 'pending');
    const second = await b.json<{ status: string }>('/v1/suggestions', { body: { ...body, reason: 'Yes, at 1:03' } });
    assert.equal(second.status, 'accepted');
    const item = (await a.json<ContentItem>('/v1/content/vimeo:42'));
    assert.ok(item.tags.includes('jump-scares'));
    assert.deepEqual(item.notes?.[0], { kind: 'tag', value: 'jump-scares', reason: 'Loud jump scare', timestamp: 63.4 });
    const account = await b.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 100 + 5);
  });

  it('queues submissions for review and verifies the creator key', async () => {
    const creator = generateIdentity();
    const client = clientFor(url, 'identity', creator);
    const id = 'vs1' + 'b'.repeat(52);
    const ts = Date.now();
    const thumbnail = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const submission = await client.json<{ id: string; status: string; verifiedCreator?: string }>('/v1/submissions', {
      body: {
        id,
        title: 'My first song',
        format: 'music',
        tags: ['indie'],
        creator: { name: 'Ada', kind: 'person' },
        thumbnail,
        creatorProof: { key: creator.id, ts, sig: signData(creator, claimSigningPayload(node.identity.id, id, ts)) },
      },
    });
    assert.equal(submission.status, 'pending');
    assert.equal(submission.verifiedCreator, creator.id);
    assert.equal((await client.json<LookupResult>(`/v1/content/${id}`)).status, 'unknown');
    await admin(url, `/v1/admin/submissions/${submission.id}/accept`, { body: { topics: ['music'] } });
    const item = await client.json<ContentItem>(`/v1/content/${id}`);
    assert.equal(item.creator?.id, creator.id);
    assert.equal(item.creator?.name, 'Ada');
    assert.ok(item.thumbnail);
    const thumb = await fetch(url + item.thumbnail);
    assert.equal(thumb.headers.get('content-type'), 'image/png');
    // the subscription feed returns the creator's newest content
    const latest = await client.json<Page<ContentItem>>('/v1/creators/latest', { body: { creators: [creator.id] } });
    assert.deepEqual(latest.items.map((i) => i.title), ['My first song']);
  });

  it('charges credits when the operator prices requests', async () => {
    await admin(url, '/v1/admin/config', { method: 'PUT', body: { pricing: { search: 7 } } });
    const client = clientFor(url, 'anonymous');
    await client.json('/v1/search', { body: { query: 'beats' } });
    const account = await client.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 93);
    await admin(url, '/v1/admin/config', { method: 'PUT', body: { pricing: { search: 0 } } });
  });

  it('rewards clients for reporting content ids and links it did not have', async () => {
    const client = clientFor(url);
    const report = (id: string) => client.json<{ known: boolean; credited: number }>('/v1/reports', { body: { id } });
    assert.deepEqual(await report('yt:brand-new'), { known: false, credited: 2 });
    assert.deepEqual(await report('yt:brand-new'), { known: true, credited: 0 }, 'what it already has earns nothing');
    assert.deepEqual(await report('https://example.org/clips/one.mp4'), { known: false, credited: 2 }, 'a plain link is kept too');
    // The entry below has a link but no content id: the report fills the missing side in.
    const filled = await report(`vs1${'c'.repeat(52)}~yt:music1`);
    assert.deepEqual(filled, { known: false, credited: 2 });
    const item = await client.json<ContentItem>('/v1/content/yt:music1');
    assert.equal(item.contentId, `vs1${'c'.repeat(52)}`, 'the report filled in the missing content id');
    const account = await client.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 100 + 2 + 2 + 2);
  });

  it('takes missing information like the creator or the publish time for credits', async () => {
    const a = clientFor(url);
    const b = clientFor(url);
    const creator = { id: 'yt:music1', kind: 'creator', value: 'Lo-fi Studio', reason: 'Named in the track list' };
    assert.equal((await a.json<{ status: string }>('/v1/suggestions', { body: creator })).status, 'pending');
    const second = await b.json<{ status: string }>('/v1/suggestions', { body: { ...creator, reason: 'Also in the description' } });
    assert.equal(second.status, 'accepted', 'once enough accounts agree the missing information is filled in');
    const item = await a.json<ContentItem>('/v1/content/yt:music1');
    assert.equal(item.creator?.name, 'Lo-fi Studio');
    const accepted = await a.json<{ id: string; status: string }>('/v1/suggestions', {
      body: { id: 'yt:music1', kind: 'published', value: '2024-05-01 12:00', reason: 'The upload date on the platform' },
    });
    assert.equal(accepted.status, 'pending');
    await admin(url, `/v1/admin/suggestions/${accepted.id}/accept`, { method: 'POST' });
    const dated = await a.json<ContentItem>('/v1/content/yt:music1');
    assert.equal(dated.publishedAt, new Date('2024-05-01 12:00').toISOString());
  });

  it('filters searches by platform', async () => {
    const client = clientFor(url);
    const youtube = await client.json<Page<ContentItem>>('/v1/search', { body: { query: '', filters: { platform: 'youtube' } }, auth: false });
    assert.deepEqual(youtube.items.map((item) => item.id), ['yt:music1']);
    const all = await client.json<Page<ContentItem>>('/v1/search', { body: { query: '' }, auth: false });
    assert.ok(all.items.length > youtube.items.length);
    const taxonomy = await client.json<{ platforms: { key: string }[] }>('/v1/taxonomy');
    assert.ok(taxonomy.platforms.some((platform) => platform.key === 'youtube'));
  });
});

describe('preview images are kept on the algorithm node', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('the-preview-bytes')]);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' }).end(png);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const previewUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/preview.png`;
  const node = await startAlgorithm();
  after(async () => {
    await node.stop();
    server.close();
  });

  it('fetches a preview once and serves it itself from then on', async () => {
    await admin(node.url(), '/v1/admin/content', {
      method: 'PUT',
      body: { id: 'yt:preview1', title: 'A clip', format: 'short-video', thumbnailUrl: previewUrl },
    });
    const entry = await waitFor(() => {
      const found = node.registry.get('yt:preview1');
      return found?.thumbnail ? found : undefined;
    });
    const item = node.registry.view(entry);
    assert.match(item.thumbnail!, /^\/v1\/thumbnails\//);
    const served = await fetch(node.url() + item.thumbnail!);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  });
});

describe('custom ranking modules', async () => {
  const { dir, cleanup } = tempDir();
  const module = join(dir, 'ranker.mjs');
  writeFileSync(module, `export default (items) => [...items].sort((a, b) => a.title.length - b.title.length);`);
  const node = await startAlgorithm({ ranking: { strategy: 'custom', module } });
  after(async () => {
    await node.stop();
    cleanup();
  });

  it('ranks with the operator module', async () => {
    for (const title of ['a much longer title', 'short', 'medium title'])
      await admin(node.url(), '/v1/admin/content', { method: 'PUT', body: { id: `yt:${title.length}`, title, format: 'video' } });
    const feed = await clientFor(node.url()).json<Page<ContentItem>>('/v1/feed', { body: {}, auth: false });
    assert.deepEqual(feed.items.map((item) => item.title), ['short', 'medium title', 'a much longer title']);
    assert.ok(ADMIN);
  });
});
