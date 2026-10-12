import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { FeedResponse, NodeEntry, PageConfig, Settings } from '../src/shared/clientapi.js';
import {
  applySettingsPatch,
  DEFAULT_SHARE_BASE_URL,
  defaultSettings,
  normalizeSettings,
  pagePreferences,
  presetPage,
  shareLink,
} from '../src/shared/clientdefaults.js';
import { admin, startAlgorithm, startClient, tempDir } from './helpers.js';

describe('page configurations', () => {
  it('come with home, videos, shorts and images pages', () => {
    const settings = defaultSettings();
    assert.deepEqual(
      settings.pages.map((page) => [page.id, page.layout, page.filters.formats.join()]),
      [
        ['home', 'canvas', ''],
        ['videos', 'grid', 'video,live'],
        ['shorts', 'shorts', 'short-video'],
        ['images', 'stream', 'image'],
      ]
    );
    assert.deepEqual(presetPage('videos').fields, ['title', 'creator', 'platform']);
    assert.deepEqual(presetPage('home').fields, ['title', 'creator'], 'the canvas shows only the title and creator');
    assert.equal(settings.loadPauseMs, 1500, 'a pause before each page of results');
    assert.equal(settings.shareBaseUrl, 'https://mabzgamesstudio.github.io/WebPages/pages/vibeShare/web');
  });

  it('keep every preset page when older settings are loaded', () => {
    const old = { ...defaultSettings(), pages: undefined, shareBaseUrl: undefined } as unknown as Partial<Settings>;
    const settings = normalizeSettings(old);
    assert.deepEqual(settings.pages.map((page) => page.id), ['home', 'videos', 'shorts', 'images']);
    assert.equal(settings.shareBaseUrl, DEFAULT_SHARE_BASE_URL);
    const custom = normalizeSettings({ pages: [{ id: 'p-music', title: 'Music', layout: 'list', fields: ['title'] } as PageConfig] });
    assert.deepEqual(custom.pages.map((page) => page.id), ['p-music', 'home', 'videos', 'shorts', 'images']);
    assert.equal(custom.pages[0].source, 'feed');
    assert.deepEqual(custom.pages[0].filters.formats, []);
  });

  it('move an unchanged old home page to the 2D canvas but keep customized ones', () => {
    const old = { ...presetPage('home'), layout: 'grid' as const, fields: ['title', 'creator', 'published', 'via'] as PageConfig['fields'] };
    const settings = normalizeSettings({ pages: [old] });
    assert.equal(settings.pages.find((page) => page.id === 'home')!.layout, 'canvas');
    const custom = normalizeSettings({ pages: [{ ...old, fields: ['title', 'likes'] }] });
    assert.equal(custom.pages.find((page) => page.id === 'home')!.layout, 'grid');
    assert.equal(applySettingsPatch(defaultSettings(), { loadPauseMs: 99_000 }).loadPauseMs, 10_000);
  });

  it('are validated when saved', () => {
    const current = defaultSettings();
    const page = (patch: Partial<PageConfig>) => ({ ...presetPage('home'), id: 'p-test', preset: undefined, ...patch });
    assert.throws(() => applySettingsPatch(current, { pages: [...current.pages, page({ layout: 'carousel' as never })] }), /Unknown layout/);
    assert.throws(() => applySettingsPatch(current, { pages: [...current.pages, page({ source: 'everything' as never })] }), /Unknown content source/);
    assert.throws(() => applySettingsPatch(current, { pages: [...current.pages, page({ id: 'videos' })] }), /duplicate page id/);
    assert.throws(() => applySettingsPatch(current, { pages: [...current.pages, page({ id: '../x' })] }), /Bad or duplicate/);
    assert.throws(() => applySettingsPatch(current, { shareBaseUrl: 'javascript:alert(1)' }), /http\(s\) URL/);
    const saved = applySettingsPatch(current, {
      shareBaseUrl: 'https://example.org/vibeshare///',
      pages: [...current.pages, page({ title: '  A title that is far too long to fit in the left panel  ', fields: ['likes', 'likes', 'title'] })],
    });
    assert.equal(saved.shareBaseUrl, 'https://example.org/vibeshare');
    const added = saved.pages.at(-1)!;
    assert.equal(added.title.length, 40);
    assert.deepEqual(added.fields, ['likes', 'title']);
  });

  it('can narrow but never raise the age rating', () => {
    const preferences = { ...defaultSettings().preferences, maxRating: '13+' as const, formats: ['music' as const] };
    assert.equal(pagePreferences(preferences, { formats: [], topics: [], onlyTopics: false, creatorKinds: [], maxRating: '18+' }).maxRating, '13+');
    assert.equal(pagePreferences(preferences, { formats: [], topics: [], onlyTopics: false, creatorKinds: [], maxRating: '10+' }).maxRating, '10+');
    const narrowed = pagePreferences(preferences, { formats: ['image'], topics: ['art'], onlyTopics: true, creatorKinds: [] });
    assert.deepEqual(narrowed.formats, ['image']);
    assert.deepEqual(narrowed.topics, ['art']);
    assert.equal(narrowed.onlyTopics, true);
    assert.deepEqual(pagePreferences(preferences, { formats: [], topics: [], onlyTopics: false, creatorKinds: [] }).formats, ['music']);
  });

  it('share links open the hosted web client on the content', () => {
    assert.equal(
      shareLink(DEFAULT_SHARE_BASE_URL, 'vs1abc~yt:dQw4w9WgXcQ'),
      'https://mabzgamesstudio.github.io/WebPages/pages/vibeShare/web/#/watch/vs1abc~yt%3AdQw4w9WgXcQ'
    );
    assert.equal(shareLink('https://example.org/app/index.html#/old', 'yt:x'), 'https://example.org/app/#/watch/yt%3Ax');
    assert.equal(shareLink('https://example.org/', 'vs1abc', 'vs:provider:vk1x@https://p.example'), 'https://example.org/#/watch/vs1abc?p=vs%3Aprovider%3Avk1x%40https%3A%2F%2Fp.example');
  });
});

describe('a client browsing pages', async () => {
  const { dir, cleanup } = tempDir();
  const algorithm = await startAlgorithm({ name: 'Curator' });
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    await algorithm.stop();
    cleanup();
  });

  const items = [
    { id: 'yt:video000001', title: 'Mountain timelapse', format: 'video', rating: 'all', topics: ['nature'], creatorId: 'nasa' },
    { id: 'yt:short000001', title: 'Mountain goat jumps', format: 'short-video', rating: 'all', topics: ['nature'] },
    { id: 'yt:short000002', title: 'Cat piano', format: 'short-video', rating: '13+', topics: ['comedy'] },
    { id: 'url:https%3A%2F%2Fexample.org%2Fa.jpg', title: 'Alpine lake', format: 'image', rating: 'all', topics: ['nature'], media: { url: 'https://example.org/a.jpg', type: 'image' } },
  ];

  it('lists each page with its own formats, query and rating', async () => {
    for (const item of items) await admin(algorithm.url(), '/v1/admin/content', { method: 'PUT', body: item });
    const added = await api<{ added: NodeEntry[] }>('/api/nodes', { body: { text: algorithm.reference() } });
    assert.equal(added.added.length, 1);

    const shorts = await api<FeedResponse>('/api/browse', { body: { source: 'feed', filters: presetPage('shorts').filters } });
    assert.deepEqual(shorts.items.map((item) => item.title).sort(), ['Cat piano', 'Mountain goat jumps']);

    const images = await api<FeedResponse>('/api/browse', { body: { source: 'feed', filters: presetPage('images').filters } });
    assert.deepEqual(images.items.map((item) => item.title), ['Alpine lake']);
    assert.equal(images.items[0].media?.url, 'https://example.org/a.jpg');

    const kids = await api<FeedResponse>('/api/browse', { body: { source: 'feed', filters: { formats: ['short-video'], maxRating: '10+' } } });
    assert.deepEqual(kids.items.map((item) => item.title), ['Mountain goat jumps']);

    const search = await api<FeedResponse>('/api/browse', { body: { source: 'search', query: 'mountain', filters: { formats: ['video'] } } });
    assert.deepEqual(search.items.map((item) => item.title), ['Mountain timelapse']);

    const none = await api<FeedResponse>('/api/browse', { body: { source: 'subscriptions' } });
    assert.deepEqual(none.items, []);
    await api('/api/subscriptions', { body: { id: 'nasa', name: 'NASA' } });
    const subscribed = await api<FeedResponse>('/api/browse', { body: { source: 'subscriptions' } });
    assert.deepEqual(subscribed.items.map((item) => item.title), ['Mountain timelapse']);
  });

  it('saves page configurations and refuses bad ones', async () => {
    const state = await api<{ settings: Settings }>('/api/state');
    const music: PageConfig = { ...presetPage('home'), id: 'p-music', preset: undefined, title: 'Music', icon: 'music', layout: 'list', fields: ['title', 'likes'] };
    const saved = await api<Settings>('/api/settings', { method: 'PATCH', body: { pages: [...state.settings.pages, music] } });
    assert.equal(saved.pages.at(-1)!.title, 'Music');
    const reloaded = await api<{ settings: Settings }>('/api/state');
    assert.deepEqual(reloaded.settings.pages.at(-1)!.fields, ['title', 'likes']);
    await assert.rejects(
      api('/api/settings', { method: 'PATCH', body: { pages: [{ ...music, layout: 'carousel' }] } }),
      /400.*Unknown layout/
    );
    await assert.rejects(api('/api/settings', { method: 'PATCH', body: { shareBaseUrl: 'ftp://example.org' } }), /400/);
    const shared = await api<Settings>('/api/settings', { method: 'PATCH', body: { shareBaseUrl: 'https://example.org/vs/' } });
    assert.equal(shared.shareBaseUrl, 'https://example.org/vs');
  });
});
