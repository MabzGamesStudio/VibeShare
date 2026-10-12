import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { Robots } from '../src/algorithm/crawler/robots.js';
import { PoliteFetcher, RobotsDisallowed } from '../src/algorithm/crawler/fetcher.js';
import { parseHtml, isoDuration } from '../src/algorithm/crawler/html.js';
import type { AlgorithmConfig } from '../src/algorithm/node.js';
import type { DeepPartial } from '../src/commerce/node.js';
import type { ContentItem, LookupResult, Page } from '../src/shared/protocol.js';
import { platformOf } from '../src/shared/sources.js';
import { admin, clientFor, startAlgorithm } from './helpers.js';
import { startFakeWeb } from './fakeweb.js';

describe('robots.txt', () => {
  const robots = Robots.parse(`
# comment
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Disallow: /page
Allow: /page
Crawl-delay: 3

User-agent: VibeShareBot
User-agent: OtherBot
Disallow: /nobots
Sitemap: https://example.org/sitemap.xml
`);

  it('uses the group that names the crawler, or the * group', () => {
    assert.equal(robots.isAllowed('VibeShareBot', '/private'), true, 'its own group does not disallow /private');
    assert.equal(robots.isAllowed('vibesharebot', '/nobots/x'), false, 'agent names match case-insensitively');
    assert.equal(robots.isAllowed('OtherBot', '/nobots'), false, 'consecutive user-agent lines share a group');
    assert.equal(robots.isAllowed('SomeBot', '/nobots'), true);
    assert.equal(robots.crawlDelaySeconds('SomeBot'), 3);
    assert.deepEqual(robots.sitemaps, ['https://example.org/sitemap.xml']);
  });

  it('applies the most specific rule, Allow winning ties, with * and $', () => {
    assert.equal(robots.isAllowed('SomeBot', '/private/x'), false);
    assert.equal(robots.isAllowed('SomeBot', '/private/public/x'), true);
    assert.equal(robots.isAllowed('SomeBot', '/docs/file.pdf'), false);
    assert.equal(robots.isAllowed('SomeBot', '/docs/file.pdf?download=1'), true, '$ anchors the end');
    assert.equal(robots.isAllowed('SomeBot', '/page'), true, 'equal length: Allow wins');
    assert.equal(robots.isAllowed('SomeBot', '/robots.txt'), true);
    assert.equal(Robots.parse('Disallow: /\n').isAllowed('x', '/a'), true, 'rules outside a group count for nobody');
    assert.equal(Robots.parse('User-agent: *\nDisallow:\n').isAllowed('x', '/a'), true, 'an empty Disallow allows everything');
  });
});

describe('page parsing', () => {
  it('reads OpenGraph, JSON-LD, links and durations', () => {
    const info = parseHtml(
      `<html lang="en-GB"><head><title>A &amp; B</title><META content="Hello" property="og:title"><meta name="description" content='Desc'>
       <link rel="canonical" href="/canonical"><script type="application/ld+json">{"@graph":[{"@type":"VideoObject","name":"V"}]}</script></head>
       <body><a href="/x#frag">X <b>link</b></a><a href="javascript:alert(1)">no</a><a href="mailto:a@b">no</a></body></html>`,
      'https://site.example/dir/page'
    );
    assert.equal(info.title, 'A & B');
    assert.equal(info.og['og:title'], 'Hello');
    assert.equal(info.description, 'Desc');
    assert.equal(info.canonical, 'https://site.example/canonical');
    assert.equal(info.lang, 'en');
    assert.equal(info.jsonLd[0]['@type'], 'VideoObject');
    assert.deepEqual(info.links, [{ href: 'https://site.example/x', text: 'X link' }]);
    assert.equal(isoDuration('PT1H2M3S'), 3723);
    assert.equal(isoDuration('PT45S'), 45);
  });
});

describe('polite fetching', async () => {
  const requests: { path: string; at: number }[] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', at: Date.now() });
    if (req.url === '/robots.txt') return res.writeHead(200).end('User-agent: *\nDisallow: /no\nCrawl-delay: 0.3\n');
    if (req.url === '/hop') return res.writeHead(302, { location: '/no/target' }).end();
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => server.close());

  const fetcher = (allowPrivate: boolean) =>
    new PoliteFetcher({ userAgent: 'VibeShareBot/0.1', defaultDelayMs: () => 0, timeoutMs: () => 5000, allowPrivate: () => allowPrivate });

  it('refuses private addresses unless allowed', async () => {
    await assert.rejects(fetcher(false).get(`${origin}/a`), /private address/);
  });

  it('obeys robots.txt, also after redirects, and spaces requests by Crawl-delay', async () => {
    const polite = fetcher(true);
    await assert.rejects(polite.get(`${origin}/no/page`), RobotsDisallowed);
    await assert.rejects(polite.get(`${origin}/hop`), RobotsDisallowed);
    assert.ok(!requests.some((request) => request.path.startsWith('/no')), 'disallowed paths are never requested');
    const before = requests.length;
    await polite.get(`${origin}/a`);
    await polite.get(`${origin}/b`);
    const [a, b] = requests.slice(before);
    assert.ok(b.at - a.at >= 280, `requests ${b.at - a.at} ms apart`);
    assert.equal(requests.filter((request) => request.path === '/robots.txt').length, 1, 'robots.txt is cached');
  });

  it('treats unreachable robots.txt as "disallow all" and missing robots.txt as "allow all"', async () => {
    const polite = fetcher(true);
    await assert.rejects(polite.get('http://127.0.0.1:1/page'), RobotsDisallowed);
    const missing = createServer((req, res) => res.writeHead(req.url === '/robots.txt' ? 404 : 200).end('fine'));
    await new Promise<void>((resolve) => missing.listen(0, '127.0.0.1', resolve));
    const response = await polite.get(`http://127.0.0.1:${(missing.address() as AddressInfo).port}/anything`);
    assert.equal(response.text(), 'fine');
    missing.close();
  });
});

describe('the crawler of an algorithm node', async () => {
  const web = await startFakeWeb();
  const base = web.url;
  const allOff = {
    youtube: { enabled: false },
    peertube: { enabled: false },
    dailymotion: { enabled: false },
    archive: { enabled: false },
    wikimedia: { enabled: false },
    openverse: { enabled: false },
    flickr: { enabled: false },
    mastodon: { enabled: false },
    bluesky: { enabled: false },
    lemmy: { enabled: false },
    web: { enabled: false },
  };
  const crawler = (adapters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({
      crawler: {
        enabled: true,
        allowPrivateAddresses: true,
        hostDelayMs: 0,
        pauseMs: 0,
        queries: ['aurora'],
        adapters: { ...allOff, ...adapters },
        ...extra,
      },
    }) as DeepPartial<AlgorithmConfig>;

  const node = await startAlgorithm(
    crawler({
      youtube: { enabled: true, channels: ['UC1'], siteUrl: `${base}/yt` },
      peertube: { enabled: true, instances: [`${base}/peertube`], searchIndex: `${base}/sepia` },
      dailymotion: { enabled: true, apiUrl: `${base}/dm` },
      archive: { enabled: true, apiUrl: `${base}/ia` },
      wikimedia: { enabled: true, apiUrl: `${base}/commons/w/api.php` },
      openverse: { enabled: true, apiUrl: `${base}/openverse/v1` },
      flickr: { enabled: true, feedUrl: `${base}/flickr/feed`, tags: [] },
      mastodon: { enabled: true, instances: [`${base}/masto`], tags: [] },
      bluesky: { enabled: true, apiUrl: `${base}/bsky` },
      lemmy: { enabled: true, instances: [`${base}/lemmy`] },
      web: { enabled: true, seeds: [`${base}/site/`], maxDepth: 1, sameSite: true },
    })
  );
  node.crawler.stop(); // no background loop: the test runs units itself
  const url = node.url();
  after(async () => {
    await node.stop();
    web.close();
  });

  const lookup = async (id: string) => (await clientFor(url).json<LookupResult>(`/v1/content/${encodeURIComponent(id)}`, { auth: false })) as ContentItem;

  it('follows YouTube channel feeds, telling shorts from videos', async () => {
    const result = await node.crawler.runOnce('youtube');
    assert.equal(result.added, 2);
    const video = await lookup('yt:longVideo01');
    assert.equal(video.title, 'How auroras form & why');
    assert.equal(video.format, 'video');
    assert.equal(video.creator?.name, 'Science Channel');
    assert.equal(video.stats.views, 12345);
    assert.equal(video.origin, 'crawler');
    assert.equal(video.rating, '13+', 'the default rating for unflagged content');
    assert.deepEqual(video.topics, ['science']);
    assert.equal((await lookup('yt:shortVid001')).format, 'short-video');
    assert.equal(platformOf('yt:shortVid001').name, 'YouTube');
  });

  it('maps PeerTube, Dailymotion, Internet Archive, Commons, Openverse, Flickr, Mastodon, Bluesky and Lemmy', async () => {
    await node.crawler.runOnce('peertube', `instance:${base}/peertube`);
    const tube = await lookup('peertube:tube.example/kkGMgK9ZtnKfYAgnEtQxbv');
    assert.equal(tube.format, 'video');
    assert.equal(tube.thumbnail, `${base}/peertube/lazy-static/thumbnails/a.jpg`);
    assert.equal(tube.creator?.name, 'Ann makes videos');
    const vertical = (await clientFor(url).json<LookupResult>(`/v1/content/${encodeURIComponent('peertube:other.example/vertical1shortuuid0001')}`, { auth: false })) as ContentItem;
    assert.equal(vertical.format, 'short-video');
    assert.equal(vertical.rating, 'nsfw');

    await node.crawler.runOnce('dailymotion', 'trending');
    const dm = await lookup('dm:x8abcde');
    assert.equal(dm.title, 'Aurora timelapse');
    assert.equal(dm.stats.platformLikes, 50);
    assert.equal(platformOf(dm.id).name, 'Dailymotion');

    await node.crawler.runOnce('archive', 'recent');
    assert.equal((await lookup('ia:aurora_film')).format, 'video');
    assert.equal((await lookup('ia:old_book')).format, 'book');
    assert.equal((await lookup('ia:live_set')).format, 'music');
    assert.equal((await clientFor(url).json<LookupResult>('/v1/content/ia:software1', { auth: false })).status, 'unknown');

    await node.crawler.runOnce('wikimedia', 'search:aurora');
    const commonsId = `url:${encodeURIComponent('https://commons.wikimedia.org/wiki/File:Aurora_borealis_over_lake.jpg')}`;
    const commons = await lookup(commonsId);
    assert.equal(commons.title, 'Aurora borealis over lake');
    assert.equal(commons.media?.type, 'image');
    assert.equal(commons.description, 'Green aurora over a lake');
    assert.equal(platformOf(commonsId).name, 'Wikimedia Commons');

    await node.crawler.runOnce('openverse', 'search:aurora');
    const ov = await lookup(`url:${encodeURIComponent('https://www.flickr.com/photos/ann/12345')}`);
    assert.equal(ov.media?.url, 'https://live.staticflickr.com/aurora_big.jpg');
    assert.equal(ov.media?.width, 1600);

    await node.crawler.runOnce('flickr', 'tags:aurora');
    const flickrItem = await lookup(`url:${encodeURIComponent('https://www.flickr.com/photos/me/555/')}`);
    assert.equal(flickrItem.media?.url, 'https://live.staticflickr.com/65535/555_abc_b.jpg');
    assert.equal(flickrItem.creator?.name, 'Me Photo');

    await node.crawler.runOnce('mastodon', `${base}/masto#aurora`);
    const toot = await lookup('masto:masto.example/@ann/111111111111111111');
    assert.equal(toot.format, 'short-video');
    assert.equal(toot.media?.url, 'https://files.masto.example/v.mp4');
    assert.equal(toot.title, 'Look at the #aurora tonight!');

    const sky = await node.crawler.runOnce('bluesky', 'search:aurora');
    assert.equal(sky.added, 1);
    const post = await lookup('bsky:did:plc:abc123/3kxyzpost');
    assert.equal(post.format, 'image');
    assert.equal(post.media?.url, 'https://cdn.bsky.app/full.jpg');
    assert.equal(node.crawler.status().queues.identify, 1, 'the shared YouTube link waits to be identified');

    await node.crawler.runOnce('lemmy');
    assert.equal((await lookup('url:' + encodeURIComponent('https://i.example/aurora.png'))).format, 'image');
    assert.equal((await lookup('yt:lemmyvid01')).format, 'video');
    assert.equal((await clientFor(url).json<LookupResult>(`/v1/content/${encodeURIComponent('url:' + encodeURIComponent('https://news.example/article'))}`, { auth: false })).status, 'unknown');
  });

  it('crawls seed sites within robots.txt, finding page media and platform links', async () => {
    const first = await node.crawler.runOnce('web');
    assert.equal(first.target, `${base}/site/`);
    const status = node.crawler.status();
    assert.ok(status.queues.frontier >= 2, 'same-site pages were queued');
    for (let i = 0; i < 6 && node.crawler.status().queues.frontier; i++) await node.crawler.runOnce('web').catch(() => undefined);
    assert.equal(web.hits.get('/private/secret') ?? 0, 0, 'robots.txt kept the crawler out of /private');
    assert.equal(web.hits.get('/private/moved') ?? 0, 0, 'also when a redirect points there');
    assert.ok(!web.hits.has('/elsewhere'), 'other sites are not followed');
    const photo = await lookup(`url:${encodeURIComponent(`${base}/site/page2`)}`);
    assert.equal(photo.title, 'Sunset over the hills');
    assert.equal(photo.format, 'image');
    const clip = await lookup(`url:${encodeURIComponent(`${base}/site/video`)}`);
    assert.equal(clip.format, 'short-video', 'a portrait JSON-LD video');
    assert.equal(clip.durationSeconds, 45);
    assert.equal(clip.media?.url, `${base}/media/clip.mp4`);
    const webStats = node.crawler.status().adapters.find((adapter) => adapter.id === 'web')!.stats;
    assert.ok(webStats.blocked >= 1);

    // Links to platforms found on pages are identified (oEmbed when allowed, else the link text).
    for (let i = 0; i < 5 && node.crawler.status().queues.identify; i++) await node.crawler.runOnce('identify').catch(() => undefined);
    const short = await lookup('yt:Short123');
    assert.equal(short.title, 'Cool short');
    assert.equal(short.format, 'short-video');
  });

  it('asks platforms when a client searches, and caches the answer', async () => {
    const client = clientFor(url);
    const before = web.hits.get('/sepia/api/v1/search/videos') ?? 0;
    const results = await client.json<Page<ContentItem>>('/v1/search', { body: { query: 'northern' }, auth: false });
    assert.ok(results.items.some((item) => item.title === 'Aurora northern over Norway'), JSON.stringify(results.items.map((i) => i.title)));
    assert.equal(web.hits.get('/sepia/api/v1/search/videos'), before + 1);
    await client.json('/v1/search', { body: { query: 'Northern' }, auth: false });
    assert.equal(web.hits.get('/sepia/api/v1/search/videos'), before + 1, 'cached');
    assert.ok(node.crawler.queries().includes('northern'), 'searches become discovery queries');
  });

  it("never overrides the operator's decisions", async () => {
    await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: 'dm:x8abcde', title: 'My own title', rating: 'all' } });
    await node.crawler.runOnce('dailymotion', 'trending');
    const dm = await lookup('dm:x8abcde');
    assert.equal(dm.title, 'My own title');
    assert.equal(dm.origin, 'operator');
    await admin(url, '/v1/admin/content/yt:longVideo01/block', { body: { reason: 'not for us' } });
    await node.crawler.runOnce('youtube');
    assert.equal((await clientFor(url).json<LookupResult>('/v1/content/yt:longVideo01', { auth: false })).status, 'blocked');
  });

  it('feeds can ask for only short videos or images', async () => {
    const client = clientFor(url);
    const shorts = await client.json<Page<ContentItem>>('/v1/feed', { body: { preferences: { formats: ['short-video'], maxRating: '18+' } }, auth: false });
    assert.ok(shorts.items.length >= 3);
    assert.ok(shorts.items.every((item) => item.format === 'short-video'));
    const images = await client.json<Page<ContentItem>>('/v1/feed', { body: { preferences: { formats: ['image'] } }, auth: false });
    assert.ok(images.items.length >= 5);
    assert.ok(images.items.every((item) => item.format === 'image'));
  });
});

describe('crawler review policy', async () => {
  const web = await startFakeWeb();
  const node = await startAlgorithm({
    crawler: {
      enabled: true,
      autoList: false,
      allowPrivateAddresses: true,
      hostDelayMs: 0,
      maxEntries: 1,
      adapters: {
        youtube: { enabled: false },
        peertube: { enabled: false },
        dailymotion: { enabled: true, apiUrl: `${web.url}/dm` },
        archive: { enabled: true, apiUrl: `${web.url}/ia` },
        wikimedia: { enabled: false },
        openverse: { enabled: false },
        flickr: { enabled: false },
        mastodon: { enabled: false },
        bluesky: { enabled: false },
        lemmy: { enabled: false },
        web: { enabled: false },
      },
    },
  } as DeepPartial<AlgorithmConfig>);
  node.crawler.stop();
  after(async () => {
    await node.stop();
    web.close();
  });

  it('keeps discoveries pending (unknown to clients) until the operator lists them', async () => {
    await node.crawler.runOnce('dailymotion', 'trending');
    const client = clientFor(node.url());
    assert.equal((await client.json<LookupResult>('/v1/content/dm:x8abcde', { auth: false })).status, 'unknown');
    const pending = await admin<{ items: { id: string }[] }>(node.url(), '/v1/admin/content?status=pending');
    assert.deepEqual(pending.items.map((item) => item.id), ['dm:x8abcde']);
    await admin(node.url(), '/v1/admin/content/bulk', { body: { ids: ['dm:x8abcde'], status: 'listed' } });
    assert.equal((await client.json<LookupResult>('/v1/content/dm:x8abcde', { auth: false })).status, 'listed');
  });

  it('prunes the oldest unvoted discoveries beyond maxEntries', async () => {
    await node.crawler.runOnce('archive', 'recent');
    const stats = node.registry.stats();
    assert.ok(stats.discovered <= 3, `${stats.discovered} kept`);
    const status = await admin<{ adapters: { id: string; stats: { added: number } }[] }>(node.url(), '/v1/admin/crawler');
    assert.equal(status.adapters.find((adapter) => adapter.id === 'archive')!.stats.added, 3);
  });
});
