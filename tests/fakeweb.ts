// A stand-in for the internet the crawler talks to: one local server answering like
// each platform's API (same paths and JSON shapes) under its own path prefix, plus a
// small website and a robots.txt.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeWeb {
  url: string;
  hits: Map<string, number>;
  close(): void;
}

const html = (head: string, body = '') => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

export async function startFakeWeb(): Promise<FakeWeb> {
  const hits = new Map<string, number>();
  let base = '';
  const routes: Record<string, (url: URL) => { type: string; body: string; status?: number; location?: string }> = {
    '/robots.txt': () => ({
      type: 'text/plain',
      body: ['User-agent: *', 'Disallow: /private', 'Allow: /private/ok', '', 'User-agent: BadBot', 'Disallow: /'].join('\n'),
    }),
    '/site/': () => ({
      type: 'text/html',
      body: html(
        '<title>Seed site</title>',
        `<a href="/site/page2">Photos</a>
         <a href="/site/video">A clip</a>
         <a href="/private/secret">Secret</a>
         <a href="/site/redirect">Moved</a>
         <a href="https://www.youtube.com/shorts/Short123">Cool short</a>
         <a href="https://vimeo.com/76979871">A Vimeo film</a>
         <a href="https://example.org/elsewhere">Another site</a>
         <a href="/site/image.png">Picture file</a>`
      ),
    }),
    '/site/page2': () => ({
      type: 'text/html',
      body: html(
        `<meta property="og:type" content="photo"><meta property="og:title" content="Sunset over the hills">
         <meta property="og:image" content="${base}/media/sunset.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="800">
         <meta name="description" content="A warm evening landscape">`
      ),
    }),
    '/site/video': () => ({
      type: 'text/html',
      body: html(
        `<title>Clip page</title><script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'VideoObject',
          name: 'Vertical clip of a waterfall',
          description: 'Nature in portrait',
          contentUrl: `${base}/media/clip.mp4`,
          thumbnailUrl: `${base}/media/clip.jpg`,
          uploadDate: '2026-01-02T03:04:05Z',
          duration: 'PT45S',
          width: 720,
          height: 1280,
        })}</script>`
      ),
    }),
    '/site/redirect': () => ({ type: 'text/plain', body: '', status: 301, location: '/private/moved' }),
    '/private/secret': () => ({ type: 'text/html', body: html('<title>Secret</title>') }),
    '/private/moved': () => ({ type: 'text/html', body: html('<title>Moved secret</title>') }),
    '/peertube/api/v1/videos': () => ({
      type: 'application/json',
      body: JSON.stringify({
        total: 2,
        data: [
          {
            uuid: '9c9de5e8-0a1e-484a-b099-e80766180a6d',
            shortUUID: 'kkGMgK9ZtnKfYAgnEtQxbv',
            name: 'Open source tour',
            duration: 300,
            thumbnailPath: '/lazy-static/thumbnails/a.jpg',
            publishedAt: '2026-03-01T10:00:00.000Z',
            views: 10,
            likes: 2,
            nsfw: false,
            aspectRatio: 1.7778,
            account: { name: 'ann', displayName: 'Ann', host: 'tube.example' },
            channel: { name: 'ann_channel', displayName: 'Ann makes videos', host: 'tube.example' },
          },
          {
            uuid: 'b6f8d2a1-0000-4000-8000-000000000001',
            shortUUID: 'vertical1shortuuid0001',
            name: 'Tiny vertical skate trick',
            duration: 15,
            thumbnailPath: '/lazy-static/thumbnails/b.jpg',
            publishedAt: '2026-03-02T10:00:00.000Z',
            nsfw: true,
            aspectRatio: 0.5625,
            channel: { name: 'sk8', displayName: 'Skate', host: 'other.example' },
          },
        ],
      }),
    }),
    '/sepia/api/v1/search/videos': (url) => ({
      type: 'application/json',
      body: JSON.stringify({
        total: 1,
        data: [
          {
            uuid: 'c0c0c0c0-1111-4222-8333-444455556666',
            shortUUID: 'auroraPeerTubeVideo001',
            name: `Aurora ${url.searchParams.get('search')} over Norway`,
            duration: 120,
            url: 'https://tube.example/w/auroraPeerTubeVideo001',
            thumbnailUrl: 'https://tube.example/thumb.jpg',
            publishedAt: '2026-02-01T00:00:00.000Z',
            channel: { name: 'north', displayName: 'North Tube', host: 'tube.example' },
          },
        ],
      }),
    }),
    '/dm/videos': () => ({
      type: 'application/json',
      body: JSON.stringify({
        page: 1,
        limit: 25,
        has_more: false,
        list: [
          {
            id: 'x8abcde',
            title: 'Aurora timelapse',
            description: 'Lights in the sky',
            'owner.id': 'x1owner',
            'owner.screenname': 'skywatch',
            aspect_ratio: 1.7777,
            created_time: 1767225600,
            thumbnail_480_url: 'https://s1.dmcdn.net/aurora.jpg',
            views_total: 1000,
            likes_total: 50,
            explicit: false,
            tags: ['aurora', 'sky'],
            duration: 64,
          },
        ],
      }),
    }),
    '/ia/advancedsearch.php': () => ({
      type: 'application/json',
      body: JSON.stringify({
        responseHeader: { status: 0 },
        response: {
          numFound: 3,
          docs: [
            { identifier: 'aurora_film', title: 'Aurora film', mediatype: 'movies', creator: 'NASA', publicdate: '2020-01-01T00:00:00Z', subject: ['space', 'aurora'] },
            { identifier: 'old_book', title: 'An old book', mediatype: 'texts' },
            { identifier: 'live_set', title: 'Aurora live set', mediatype: 'etree', collection: ['etree', 'GratefulDead'] },
            { identifier: 'software1', title: 'A program', mediatype: 'software' },
          ],
        },
      }),
    }),
    '/commons/w/api.php': () => ({
      type: 'application/json',
      body: JSON.stringify({
        batchcomplete: '',
        query: {
          pages: {
            '101': {
              pageid: 101,
              ns: 6,
              title: 'File:Aurora_borealis_over_lake.jpg',
              imageinfo: [
                {
                  url: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Aurora.jpg',
                  thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/Aurora.jpg/960px-Aurora.jpg',
                  thumbwidth: 960,
                  thumbheight: 640,
                  width: 4000,
                  height: 2667,
                  mime: 'image/jpeg',
                  user: 'Photographer',
                  timestamp: '2025-12-24T00:00:00Z',
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:Aurora_borealis_over_lake.jpg',
                  extmetadata: { ImageDescription: { value: '<p>Green <b>aurora</b> over a lake</p>' }, Categories: { value: 'Auroras|Night' } },
                },
              ],
            },
          },
        },
      }),
    }),
    '/openverse/v1/images/': () => ({
      type: 'application/json',
      body: JSON.stringify({
        result_count: 1,
        results: [
          {
            id: 'ov-1',
            title: 'Aurora over the lake',
            url: 'https://live.staticflickr.com/aurora_big.jpg',
            thumbnail: 'https://api.openverse.org/v1/images/ov-1/thumb/',
            foreign_landing_url: 'https://www.flickr.com/photos/ann/12345',
            creator: 'Ann',
            creator_url: 'https://www.flickr.com/photos/ann',
            source: 'flickr',
            width: 1600,
            height: 900,
            tags: [{ name: 'aurora' }, { name: 'night' }],
            mature: false,
          },
        ],
      }),
    }),
    '/flickr/feed': () => ({
      type: 'application/json',
      body: JSON.stringify({
        title: 'Recent Uploads tagged aurora',
        items: [
          {
            title: 'Northern lights',
            link: 'https://www.flickr.com/photos/me/555/',
            media: { m: 'https://live.staticflickr.com/65535/555_abc_m.jpg' },
            published: '2026-01-05T00:00:00Z',
            author: 'nobody@flickr.com ("Me Photo")',
            author_id: '123@N00',
            tags: 'aurora night sky',
          },
        ],
      }),
    }),
    '/masto/api/v1/timelines/tag/aurora': () => ({
      type: 'application/json',
      body: JSON.stringify([
        {
          id: '111111111111111111',
          url: 'https://masto.example/@ann/111111111111111111',
          created_at: '2026-02-02T00:00:00.000Z',
          content: '<p>Look at the <a href="#">#aurora</a> tonight!</p>',
          sensitive: false,
          language: 'en',
          favourites_count: 7,
          account: { acct: 'ann', username: 'ann', display_name: 'Ann', url: 'https://masto.example/@ann' },
          media_attachments: [
            { type: 'video', url: 'https://files.masto.example/v.mp4', preview_url: 'https://files.masto.example/v.jpg', meta: { original: { width: 720, height: 1280, duration: 12 } } },
          ],
          tags: [{ name: 'aurora' }],
        },
        { id: '2', url: 'https://masto.example/@bob/222222222222222222', content: '<p>text only</p>', media_attachments: [], account: { acct: 'bob' } },
      ]),
    }),
    '/bsky/xrpc/app.bsky.feed.searchPosts': () => ({
      type: 'application/json',
      body: JSON.stringify({
        posts: [
          {
            uri: 'at://did:plc:abc123/app.bsky.feed.post/3kxyzpost',
            cid: 'bafy',
            author: { did: 'did:plc:abc123', handle: 'sky.bsky.social', displayName: 'Sky' },
            record: { text: 'Aurora tonight over the fjord', createdAt: '2026-02-03T00:00:00.000Z', langs: ['en'] },
            embed: {
              $type: 'app.bsky.embed.images#view',
              images: [{ thumb: 'https://cdn.bsky.app/thumb.jpg', fullsize: 'https://cdn.bsky.app/full.jpg', alt: 'aurora', aspectRatio: { width: 1000, height: 1500 } }],
            },
            likeCount: 3,
          },
          {
            uri: 'at://did:plc:def/app.bsky.feed.post/3kshare',
            author: { did: 'did:plc:def', handle: 'sharer.bsky.social' },
            record: { text: 'watch this' },
            embed: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://www.youtube.com/watch?v=ext12345678', title: 'Aurora video' } },
          },
        ],
      }),
    }),
    '/lemmy/api/v3/post/list': () => ({
      type: 'application/json',
      body: JSON.stringify({
        posts: [
          {
            post: { id: 1, name: 'Aurora picture', url: 'https://i.example/aurora.png', url_content_type: 'image/png', nsfw: false, published: '2026-02-04T00:00:00Z', thumbnail_url: 'https://lemmy.example/pictrs/thumb.png', ap_id: 'https://lemmy.example/post/1' },
            creator: { name: 'bob', actor_id: 'https://lemmy.example/u/bob' },
            community: { name: 'pics' },
            counts: { upvotes: 42 },
          },
          { post: { id: 2, name: 'A news article', url: 'https://news.example/article' }, creator: { name: 'carl' } },
          { post: { id: 3, name: 'Funny clip', url: 'https://www.youtube.com/watch?v=lemmyvid01' }, creator: { name: 'dan' }, counts: { score: 5 } },
        ],
      }),
    }),
    '/yt/feeds/videos.xml': (url) => ({
      type: 'application/atom+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>Channel</title>
 <entry>
  <id>yt:video:longVideo01</id>
  <yt:videoId>longVideo01</yt:videoId>
  <yt:channelId>${url.searchParams.get('channel_id')}</yt:channelId>
  <title>How auroras form &amp; why</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=longVideo01"/>
  <author><name>Science Channel</name><uri>https://www.youtube.com/channel/UC1</uri></author>
  <published>2026-01-10T12:00:00+00:00</published>
  <media:group>
   <media:title>How auroras form &amp; why</media:title>
   <media:thumbnail url="https://i1.ytimg.com/vi/longVideo01/hqdefault.jpg" width="480" height="360"/>
   <media:description>The physics of the northern lights.</media:description>
   <media:community><media:starRating count="321" average="5.00" min="1" max="5"/><media:statistics views="12345"/></media:community>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:shortVid001</id>
  <yt:videoId>shortVid001</yt:videoId>
  <yt:channelId>${url.searchParams.get('channel_id')}</yt:channelId>
  <title>Aurora in 30 seconds</title>
  <link rel="alternate" href="https://www.youtube.com/shorts/shortVid001"/>
  <author><name>Science Channel</name></author>
  <published>2026-01-11T12:00:00+00:00</published>
  <media:group><media:thumbnail url="https://i1.ytimg.com/vi/shortVid001/hqdefault.jpg" width="480" height="360"/></media:group>
 </entry>
</feed>`,
    }),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const answer = route(url);
    res.writeHead(answer.status ?? 200, { 'content-type': answer.type, ...(answer.location ? { location: answer.location } : {}) }).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: base, hits, close: () => server.close() };
}
