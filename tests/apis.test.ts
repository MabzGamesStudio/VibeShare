// Crawler adapters for official APIs. The platforms' API hosts are routed to a local
// server answering with responses in each API's documented format.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { SiteBlocked } from '../src/algorithm/crawler/fetcher.js';
import type { AlgorithmNode } from '../src/algorithm/node.js';
import { prioritize, sourceKeyOf } from '../src/algorithm/sources.js';
import type { ContentItem, Page } from '../src/shared/protocol.js';
import { admin, startAlgorithm } from './helpers.js';

const HOSTS = [
  'api.vimeo.com',
  'id.twitch.tv',
  'api.twitch.tv',
  'api.unsplash.com',
  'api.pexels.com',
  'api.giphy.com',
  'tenor.googleapis.com',
  'api.imgur.com',
  'www.deviantart.com',
  'api.europeana.eu',
  'www.reddit.com',
  'oauth.reddit.com',
  'api.tumblr.com',
  'api.twitter.com',
  'graph.facebook.com',
  'accounts.spotify.com',
  'api.spotify.com',
  'api.jamendo.com',
  'freesound.org',
  'www.googleapis.com',
  'www.flickr.com',
];

const now = '2026-01-02T03:04:05Z';

/** Answers of each API, keyed by host + path. */
function answer(host: string, path: string, query: URLSearchParams): { status?: number; headers?: Record<string, string>; body: unknown } | null {
  switch (`${host}${path}`) {
    case 'api.vimeo.com/videos':
      return {
        body: {
          data: [
            {
              uri: '/videos/111',
              name: 'Aurora timelapse',
              description: 'Northern lights over Norway',
              link: 'https://vimeo.com/111',
              duration: 125,
              width: 1920,
              height: 1080,
              created_time: now,
              pictures: { sizes: [{ width: 640, link: 'https://i.vimeocdn.com/640.jpg' }, { width: 1280, link: 'https://i.vimeocdn.com/1280.jpg' }, { width: 1920, link: 'https://i.vimeocdn.com/1920.jpg' }] },
              user: { name: 'Sky Films', link: 'https://vimeo.com/sky', uri: '/users/42' },
              stats: { plays: 1000 },
              metadata: { connections: { likes: { total: 50 } } },
              content_rating: ['safe'],
            },
            { uri: '/videos/222', name: 'Vertical clip', width: 1080, height: 1920, content_rating: ['nudity'] },
          ],
        },
      };
    case 'id.twitch.tv/oauth2/token':
      return { body: { access_token: 'tw-token', expires_in: 3600 } };
    case 'api.twitch.tv/helix/search/channels':
      return { body: { data: [{ broadcaster_login: 'skywatch', display_name: 'SkyWatch', title: 'Live aurora cam', thumbnail_url: 'https://static-cdn.jtvnw.net/sky.png', is_live: true, started_at: now, tags: ['Space'] }] } };
    case 'api.twitch.tv/helix/search/categories':
      return { body: { data: [{ id: '509670', name: 'Science & Technology' }] } };
    case 'api.twitch.tv/helix/videos':
      return {
        body: {
          data: [
            { id: '777', user_login: 'skywatch', user_name: 'SkyWatch', title: 'Best auroras', created_at: now, url: 'https://www.twitch.tv/videos/777', thumbnail_url: 'https://x.example/%{width}x%{height}.jpg', view_count: 12, duration: '1h2m3s' },
          ],
        },
      };
    case 'api.unsplash.com/search/photos':
      return {
        body: {
          results: [
            {
              width: 4000,
              height: 6000,
              alt_description: 'green aurora over a lake',
              created_at: now,
              likes: 9,
              urls: { regular: 'https://images.unsplash.com/photo-1?w=1080', small: 'https://images.unsplash.com/photo-1?w=400' },
              links: { html: 'https://unsplash.com/photos/u1' },
              user: { username: 'ann', name: 'Ann', links: { html: 'https://unsplash.com/@ann' } },
            },
          ],
        },
      };
    case 'api.pexels.com/v1/search':
      return {
        body: {
          photos: [
            {
              id: 1,
              width: 3000,
              height: 2000,
              url: 'https://www.pexels.com/photo/aurora-1/',
              photographer: 'Pat',
              photographer_url: 'https://www.pexels.com/@pat',
              photographer_id: 5,
              alt: 'Aurora borealis',
              src: { large2x: 'https://images.pexels.com/1-large2x.jpeg', medium: 'https://images.pexels.com/1-medium.jpeg' },
            },
          ],
        },
      };
    case 'api.pexels.com/videos/search':
      return {
        body: {
          videos: [
            {
              id: 2,
              width: 1080,
              height: 1920,
              url: 'https://www.pexels.com/video/northern-lights-dancing-2/',
              image: 'https://images.pexels.com/videos/2/thumb.jpg',
              duration: 15,
              user: { id: 6, name: 'Vic', url: 'https://www.pexels.com/@vic' },
              video_files: [
                { quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, link: 'https://videos.pexels.com/2-hd.mp4' },
                { quality: 'uhd', file_type: 'video/mp4', width: 2160, height: 3840, link: 'https://videos.pexels.com/2-uhd.mp4' },
              ],
            },
          ],
        },
      };
    case 'api.giphy.com/v1/gifs/search':
      if (query.get('q') === 'busy') return { status: 429, headers: { 'retry-after': '120' }, body: { message: 'Too many requests' } };
      return {
        body: {
          data: [
            {
              url: 'https://giphy.com/gifs/aurora-g1',
              title: 'Aurora GIF',
              username: 'nasa',
              rating: 'pg',
              import_datetime: '2026-01-01 10:00:00',
              user: { display_name: 'NASA', profile_url: 'https://giphy.com/nasa' },
              images: { original: { url: 'https://media.giphy.com/g1.gif', width: '480', height: '270' }, fixed_height_still: { url: 'https://media.giphy.com/g1_s.gif' } },
            },
          ],
        },
      };
    case 'tenor.googleapis.com/v2/search':
      return {
        body: {
          results: [
            {
              content_description: 'Dancing aurora',
              itemurl: 'https://tenor.com/view/aurora-t1',
              created: 1700000000.5,
              tags: ['aurora'],
              media_formats: { gif: { url: 'https://media.tenor.com/t1.gif', dims: [498, 280] }, tinygif: { url: 'https://media.tenor.com/t1-tiny.gif' } },
            },
          ],
        },
      };
    case 'api.imgur.com/3/gallery/search/top/all/0':
      return {
        body: {
          data: [
            { id: 'abc', title: 'Aurora album', is_album: true, images: [{ id: 'img1', type: 'image/jpeg', link: 'https://i.imgur.com/img1.jpg', width: 800, height: 600 }], account_url: 'skyfan', datetime: 1700000000, views: 100, ups: 10, tags: [{ name: 'aurora' }] },
            { id: 'vid', title: 'Aurora video', is_album: false, type: 'video/mp4', link: 'https://i.imgur.com/vid.mp4', mp4: 'https://i.imgur.com/vid.mp4', width: 720, height: 1280, nsfw: true },
          ],
        },
      };
    case 'www.deviantart.com/oauth2/token':
      return { body: { access_token: 'da-token', expires_in: 3600 } };
    case 'www.deviantart.com/api/v1/oauth2/browse/tags':
      return {
        body: {
          results: [
            {
              url: 'https://www.deviantart.com/artist/art/Aurora-1',
              title: 'Aurora',
              is_mature: false,
              author: { username: 'artist' },
              published_time: '1700000000',
              content: { src: 'https://images.example/d1.jpg', width: 1200, height: 800 },
              thumbs: [{ src: 'https://t.example/d1-150.jpg' }, { src: 'https://t.example/d1-300.jpg' }],
              stats: { favourites: 30 },
            },
            { url: 'https://www.deviantart.com/x/art/Mature-2', title: 'Mature', is_mature: true, content: { src: 'https://images.example/d2.jpg' } },
          ],
        },
      };
    case 'api.europeana.eu/record/v2/search.json':
      return {
        body: {
          items: [
            {
              guid: 'https://www.europeana.eu/item/1/a',
              title: ['Aurora borealis, painting'],
              dcCreator: ['Frederic Edwin Church'],
              edmPreview: ['https://api.europeana.eu/thumbnail/v3/400/x'],
              edmIsShownBy: ['https://museum.example/aurora.jpg'],
              type: 'IMAGE',
              year: ['1865'],
            },
            { type: 'TEXT', title: ['A book'], guid: 'https://www.europeana.eu/item/2' },
          ],
        },
      };
    case 'www.reddit.com/api/v1/access_token':
      return { body: { access_token: 'rd-token', expires_in: 86400 } };
    case 'oauth.reddit.com/r/EarthPorn/hot':
    case 'oauth.reddit.com/search':
      return {
        body: {
          data: {
            children: [
              {
                data: {
                  title: 'Aurora over Iceland [4000x3000]',
                  permalink: '/r/EarthPorn/comments/p1/aurora/',
                  url: 'https://i.redd.it/p1.jpg',
                  post_hint: 'image',
                  author: 'photog',
                  subreddit: 'EarthPorn',
                  created_utc: 1700000000,
                  score: 4200,
                  preview: { images: [{ source: { url: 'https://preview.redd.it/p1.jpg', width: 4000, height: 3000 }, resolutions: [{ url: 'https://preview.redd.it/p1-640.jpg', width: 640 }, { url: 'big', width: 1080 }] }] },
                },
              },
              { data: { title: 'Great aurora video', permalink: '/r/videos/comments/p2/x/', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', post_hint: 'rich:video', author: 'fan' } },
              { data: { title: 'Discussion', permalink: '/r/x/comments/p3/', is_self: true } },
            ],
          },
        },
      };
    case 'api.tumblr.com/v2/tagged':
      return {
        body: {
          response: [
            {
              type: 'photo',
              blog_name: 'skyblog',
              post_url: 'https://skyblog.tumblr.com/post/1',
              timestamp: 1700000000,
              tags: ['aurora'],
              summary: 'Aurora tonight',
              note_count: 12,
              photos: [{ original_size: { url: 'https://64.media.tumblr.com/a.jpg', width: 1280, height: 853 }, alt_sizes: [{ url: 'https://64.media.tumblr.com/a_1280.jpg', width: 1280 }, { url: 'https://64.media.tumblr.com/a_500.jpg', width: 500 }] }],
            },
            { type: 'video', blog_name: 'vidblog', post_url: 'https://vidblog.tumblr.com/post/2', timestamp: 1700000001, summary: 'Aurora video', video_url: 'https://va.media.tumblr.com/v.mp4', thumbnail_url: 'https://64.media.tumblr.com/v.jpg', thumbnail_width: 540, thumbnail_height: 960 },
            { type: 'text', post_url: 'https://textblog.tumblr.com/post/3' },
          ],
        },
      };
    case 'api.twitter.com/2/tweets/search/recent':
      return {
        body: {
          data: [
            { id: '1001', text: 'Aurora tonight! https://t.co/abc', author_id: '9', created_at: now, attachments: { media_keys: ['3_1'] }, public_metrics: { like_count: 77 } },
            { id: '1002', text: 'Video', author_id: '9', possibly_sensitive: true, attachments: { media_keys: ['7_2'] } },
          ],
          includes: {
            media: [
              { media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 1200, height: 800 },
              {
                media_key: '7_2',
                type: 'video',
                preview_image_url: 'https://pbs.twimg.com/v.jpg',
                width: 720,
                height: 1280,
                duration_ms: 12000,
                variants: [
                  { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/v.m3u8' },
                  { content_type: 'video/mp4', bit_rate: 256000, url: 'https://video.twimg.com/low.mp4' },
                  { content_type: 'video/mp4', bit_rate: 2176000, url: 'https://video.twimg.com/high.mp4' },
                ],
              },
            ],
            users: [{ id: '9', name: 'Sky Watcher', username: 'skywatcher' }],
          },
        },
      };
    case 'graph.facebook.com/v21.0/ig_hashtag_search':
      return { body: { data: [{ id: '178' }] } };
    case 'graph.facebook.com/v21.0/178/top_media':
      return {
        body: {
          data: [
            { caption: 'Aurora over Tromsø #aurora #norway', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/a.jpg', permalink: 'https://www.instagram.com/p/ABC123/', timestamp: '2026-01-01T00:00:00+0000', like_count: 500 },
            { caption: 'Reel', media_type: 'VIDEO', permalink: 'https://www.instagram.com/reel/XYZ789/' },
          ],
        },
      };
    case 'accounts.spotify.com/api/token':
      return { body: { access_token: 'sp-token', expires_in: 3600 } };
    case 'api.spotify.com/v1/search':
      return {
        body: {
          tracks: {
            items: [
              {
                id: 't1',
                name: 'Aurora Song',
                artists: [{ id: 'a1', name: 'Band' }],
                album: { images: [{ url: 'https://i.scdn.co/640.jpg' }, { url: 'https://i.scdn.co/300.jpg' }], release_date: '2025-05-01' },
                duration_ms: 215000,
                explicit: false,
                external_urls: { spotify: 'https://open.spotify.com/track/t1' },
              },
            ],
          },
          episodes: {
            items: [
              { id: 'e1', name: 'Aurora science', description: 'A podcast', images: [{ url: 'https://i.scdn.co/e.jpg' }], duration_ms: 1800000, release_date: '2026-02-01', explicit: true, external_urls: { spotify: 'https://open.spotify.com/episode/e1' } },
              null,
            ],
          },
        },
      };
    case 'api.jamendo.com/v3.0/tracks/':
      return {
        body: {
          results: [
            { id: '55', name: 'Northern Lights', duration: 200, artist_id: '7', artist_name: 'Ambient Artist', image: 'https://usercontent.jamendo.com/55.jpg', audio: 'https://prod-1.storage.jamendo.com/55.mp3', releasedate: '2020-01-01', shareurl: 'https://www.jamendo.com/track/55' },
          ],
        },
      };
    case 'freesound.org/apiv2/search/text/':
      return {
        body: {
          results: [
            {
              name: 'Wind in the north',
              description: '<p>Recorded <b>outside</b></p>',
              username: 'recorder',
              url: 'https://freesound.org/people/recorder/sounds/9/',
              duration: 30.5,
              previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/9-hq.mp3' },
              images: { waveform_m: 'https://cdn.freesound.org/displays/9_wave.png' },
              tags: ['wind'],
              created: '2019-01-01T00:00:00',
            },
          ],
        },
      };
    case 'www.googleapis.com/youtube/v3/search':
      return { body: { items: [{ id: { videoId: 'yt123' }, snippet: { title: 'Aurora &amp; stars', channelId: 'UCx', channelTitle: 'Chan', publishedAt: now, thumbnails: { high: { url: 'https://i.ytimg.com/yt123.jpg' } } } }] } };
    case 'www.flickr.com/services/rest/':
      return {
        body: {
          stat: 'ok',
          photos: { photo: [{ id: '5', owner: '12@N01', title: 'Aurora', ownername: 'Fl', dateupload: '1700000000', tags: 'aurora night', views: '10', url_l: 'https://live.staticflickr.com/l.jpg', width_l: 1024, height_l: 683, url_m: 'https://live.staticflickr.com/m.jpg' }] },
        },
      };
  }
  return null;
}

interface Logged {
  host: string;
  path: string;
  query: URLSearchParams;
  method: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describe('crawler adapters for official APIs', async () => {
  const requests: Logged[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const [, host, ...rest] = url.pathname.split('/');
    const path = `/${rest.join('/')}`;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ host, path, query: url.searchParams, method: req.method ?? 'GET', headers: req.headers, body });
      const found = answer(host, path, url.searchParams);
      res.writeHead(found ? (found.status ?? 200) : 404, { 'content-type': 'application/json', ...found?.headers });
      res.end(JSON.stringify(found?.body ?? { error: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The platforms' API hosts go to the local server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (HOSTS.includes(url.host)) return realFetch(`${base}/${url.host}${url.pathname}${url.search}`, init);
    return realFetch(input, init);
  }) as typeof fetch;

  const keys = {
    youtube: { apiKey: 'yt-key', channels: [] },
    flickr: { apiKey: 'fl-key', tags: [] },
    vimeo: { accessToken: 'vm-token' },
    twitch: { clientId: 'tw-id', clientSecret: 'tw-secret' },
    unsplash: { accessKey: 'us-key' },
    pexels: { apiKey: 'px-key' },
    giphy: { apiKey: 'gf-key' },
    tenor: { apiKey: 'tn-key' },
    imgur: { clientId: 'im-id' },
    deviantart: { clientId: 'da-id', clientSecret: 'da-secret' },
    europeana: { apiKey: 'eu-key' },
    reddit: { clientId: 'rd-id', clientSecret: 'rd-secret', subreddits: ['EarthPorn'], dailyLimit: 4, searchShare: 0.5 },
    tumblr: { apiKey: 'tb-key' },
    x: { bearerToken: 'x-token' },
    instagram: { accessToken: 'ig-token', userId: '1784', hashtags: [] },
    spotify: { clientId: 'sp-id', clientSecret: 'sp-secret' },
    jamendo: { clientId: 'jm-id' },
    freesound: { token: 'fs-token' },
  };
  const off = Object.fromEntries(['peertube', 'dailymotion', 'archive', 'wikimedia', 'openverse', 'mastodon', 'bluesky', 'lemmy', 'web'].map((id) => [id, { enabled: false }]));
  let node: AlgorithmNode;
  before(async () => {
    const { x: _x, ...fixed } = keys;
    node = await startAlgorithm({
      crawler: { enabled: true, autoList: true, hostDelayMs: 0, apiDelayMs: 0, queries: ['aurora'], learnFromSearches: false, adapters: { ...off, ...fixed } },
    });
    node.crawler.stop(); // the test runs the units itself
    // Set through the dashboard rather than the command line, so a later change can clear it.
    await admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { crawler: { adapters: { x: keys.x } } } });
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await node.stop();
    server.close();
  });

  const entry = (id: string) => node.registry.get(id);
  const urlId = (page: string) => `url:${encodeURIComponent(page)}`;
  const last = (host: string) => requests.filter((request) => request.host === host).at(-1)!;

  it('maps every platform to content: ids, formats, media, creators, ratings', async () => {
    for (const adapter of Object.keys(keys)) {
      const target = adapter === 'reddit' ? 'q:r/EarthPorn' : 'q:aurora';
      const result = await node.crawler.runOnce(adapter, target);
      assert.ok(result.found > 0, `${adapter} found nothing`);
    }

    const vimeo = entry('vimeo:111')!;
    assert.equal(vimeo.format, 'video');
    assert.equal(vimeo.rating, 'all');
    assert.equal(vimeo.thumbnailUrl, 'https://i.vimeocdn.com/1280.jpg');
    assert.equal(entry('vimeo:222')!.format, 'short-video');
    assert.equal(entry('vimeo:222')!.rating, '18+');
    assert.equal(last('api.vimeo.com').headers.authorization, 'bearer vm-token');

    assert.equal(entry('twitch:skywatch')!.format, 'live');
    assert.equal(entry('twitch:v777')!.durationSeconds, 3723);
    assert.equal(entry('twitch:v777')!.thumbnailUrl, 'https://x.example/640x360.jpg');
    assert.equal(last('api.twitch.tv').headers.authorization, 'Bearer tw-token');
    assert.equal(last('api.twitch.tv').headers['client-id'], 'tw-id');

    const unsplash = entry(urlId('https://unsplash.com/photos/u1'))!;
    assert.equal(unsplash.format, 'image');
    assert.deepEqual(unsplash.media, { url: 'https://images.unsplash.com/photo-1?w=1080', type: 'image', width: 1080, height: 1620 });
    assert.equal(last('api.unsplash.com').headers.authorization, 'Client-ID us-key');

    assert.equal(entry(urlId('https://www.pexels.com/photo/aurora-1/'))!.format, 'image');
    const pexelsVideo = entry(urlId('https://www.pexels.com/video/northern-lights-dancing-2/'))!;
    assert.equal(pexelsVideo.format, 'short-video');
    assert.equal(pexelsVideo.title, 'Northern lights dancing');
    assert.equal(pexelsVideo.media?.url, 'https://videos.pexels.com/2-hd.mp4', 'the largest file up to 1080p');
    assert.equal(last('api.pexels.com').headers.authorization, 'px-key');

    assert.equal(entry(urlId('https://giphy.com/gifs/aurora-g1'))!.rating, '10+');
    assert.equal(entry(urlId('https://tenor.com/view/aurora-t1'))!.media?.width, 498);
    assert.equal(entry(urlId('https://imgur.com/gallery/abc'))!.media?.url, 'https://i.imgur.com/img1.jpg');
    const imgurVideo = entry(urlId('https://imgur.com/gallery/vid'))!;
    assert.equal(imgurVideo.format, 'short-video');
    assert.equal(imgurVideo.rating, '18+');
    assert.equal(last('api.imgur.com').headers.authorization, 'Client-ID im-id');

    assert.equal(entry(urlId('https://www.deviantart.com/artist/art/Aurora-1'))!.thumbnailUrl, 'https://t.example/d1-300.jpg');
    assert.equal(entry(urlId('https://www.deviantart.com/x/art/Mature-2')), undefined, 'mature art is skipped');
    const painting = entry(urlId('https://www.europeana.eu/item/1/a'))!;
    assert.equal(painting.media?.url, 'https://museum.example/aurora.jpg');
    assert.equal(painting.publishedAt.slice(0, 4), '1865');
    assert.equal(entry(urlId('https://www.europeana.eu/item/2')), undefined, 'texts are skipped');

    const redditImage = entry(urlId('https://www.reddit.com/r/EarthPorn/comments/p1/aurora/'))!;
    assert.equal(redditImage.media?.url, 'https://i.redd.it/p1.jpg');
    assert.equal(redditImage.thumbnailUrl, 'https://preview.redd.it/p1-640.jpg');
    assert.ok(entry('yt:dQw4w9WgXcQ'), 'a Reddit post of a YouTube video lists the video itself');
    const tokenRequest = requests.find((request) => request.host === 'www.reddit.com')!;
    assert.equal(tokenRequest.headers.authorization, `Basic ${Buffer.from('rd-id:rd-secret').toString('base64')}`);
    assert.equal(tokenRequest.body, 'grant_type=client_credentials');
    assert.equal(last('oauth.reddit.com').headers.authorization, 'bearer rd-token');

    assert.equal(entry(urlId('https://skyblog.tumblr.com/post/1'))!.thumbnailUrl, 'https://64.media.tumblr.com/a_500.jpg');
    assert.equal(entry(urlId('https://vidblog.tumblr.com/post/2'))!.format, 'short-video');

    const post = entry('x:1001')!;
    assert.equal(post.title, 'Aurora tonight!');
    assert.equal(post.format, 'image');
    const xVideo = entry('x:1002')!;
    assert.equal(xVideo.media?.url, 'https://video.twimg.com/high.mp4', 'the best mp4 variant');
    assert.equal(xVideo.rating, '18+');
    assert.equal(last('api.twitter.com').headers.authorization, 'Bearer x-token');

    assert.equal(entry('ig:p/ABC123')!.format, 'image');
    assert.deepEqual(entry('ig:p/ABC123')!.tags, ['aurora', 'norway']);
    assert.equal(entry('ig:reel/XYZ789')!.format, 'short-video');
    assert.equal(last('graph.facebook.com').query.get('user_id'), '1784');

    assert.equal(entry('spotify:track:t1')!.format, 'music');
    assert.equal(entry('spotify:track:t1')!.thumbnailUrl, 'https://i.scdn.co/300.jpg');
    assert.equal(entry('spotify:episode:e1')!.format, 'podcast');
    assert.equal(entry('spotify:episode:e1')!.rating, '16+');

    assert.equal(entry(urlId('https://www.jamendo.com/track/55'))!.media?.type, 'audio');
    const sound = entry(urlId('https://freesound.org/people/recorder/sounds/9/'))!;
    assert.equal(sound.format, 'audio');
    assert.equal(sound.description, 'Recorded outside');

    assert.equal(entry('yt:yt123')!.title, 'Aurora & stars');
    assert.equal(last('www.googleapis.com').query.get('key'), 'yt-key');
    assert.equal(entry(urlId('https://www.flickr.com/photos/12@N01/5/'))!.media?.width, 1024);
  });

  it('reuses app tokens until they expire', () => {
    assert.equal(requests.filter((request) => request.host === 'id.twitch.tv').length, 1);
    assert.equal(requests.filter((request) => request.host === 'www.reddit.com').length, 1);
  });

  it('keeps part of each daily budget for client searches', async () => {
    // Reddit: 4 calls a day, half kept for searches. Crawling used its 2 (token + listing).
    let reddit = node.crawler.status().adapters.find((adapter) => adapter.id === 'reddit')!;
    assert.deepEqual(reddit.api?.usedToday, { crawl: 2, search: 0 });
    const before = requests.length;
    const again = await node.crawler.runOnce('reddit', 'q:r/EarthPorn');
    assert.equal(again.found, 0);
    assert.equal(requests.length, before, 'no call once crawling used its share');
    assert.equal(node.crawler.budgetLeft('reddit', 'search'), true);

    await node.crawler.search('aurora borealis');
    await node.crawler.search('northern lights');
    await node.crawler.search('night sky');
    reddit = node.crawler.status().adapters.find((adapter) => adapter.id === 'reddit')!;
    assert.deepEqual(reddit.api?.usedToday, { crawl: 2, search: 2 }, 'searches used the rest, then stopped');
    const searched = requests.filter((request) => request.host === 'oauth.reddit.com' && request.path === '/search');
    assert.deepEqual(
      searched.map((request) => request.query.get('q')),
      ['aurora borealis', 'northern lights']
    );
  });

  it('pauses an API that says it is overloaded', async () => {
    await assert.rejects(node.crawler.runOnce('giphy', 'q:busy'));
    const giphy = node.crawler.status().adapters.find((adapter) => adapter.id === 'giphy')!;
    assert.ok(giphy.api?.pausedUntil, 'paused after 429');
    assert.match(giphy.stats.lastError ?? '', /rate limited/);
    const before = requests.length;
    await node.crawler.runOnce('giphy', 'q:aurora');
    assert.equal(requests.length, before, 'no calls while paused');
  });

  it('leaves out APIs without credentials and blocked sources', async () => {
    await admin(node.url(), '/v1/admin/config', {
      method: 'PUT',
      body: { crawler: { adapters: { x: { bearerToken: '' } }, blockedSources: ['unsplash', 'youtube'] } },
    });
    const before = requests.length;
    await node.crawler.search('polar night');
    const hosts = new Set(requests.slice(before).map((request) => request.host));
    assert.ok(hosts.has('api.vimeo.com'), 'configured APIs are searched');
    assert.ok(!hosts.has('api.twitter.com'), 'X has no token any more');
    assert.ok(!hosts.has('api.unsplash.com'), 'Unsplash is blocked');
    assert.ok(!hosts.has('www.googleapis.com'), 'YouTube is blocked');
    const status = node.crawler.status();
    assert.equal(status.adapters.find((adapter) => adapter.id === 'x')!.api?.configured, false);
    assert.equal(status.adapters.find((adapter) => adapter.id === 'unsplash')!.blocked, true);
  });

  it('never fetches blocked sites', async () => {
    await admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { crawler: { sites: { allow: [], block: ['blocked.example'] } } } });
    await assert.rejects(node.crawler.fetcher.get('https://www.blocked.example/page'), SiteBlocked);
    await assert.rejects(node.crawler.fetcher.api('https://api.unsplash.com/search/photos'), SiteBlocked, 'hosts of blocked platforms too');
  });
});

describe('source priorities', async () => {
  const node = await startAlgorithm({ ranking: { strategy: 'new' } });
  after(() => node.stop());
  const native = `vs1${'a'.repeat(52)}`;
  const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

  it('find the source of any content id', () => {
    assert.equal(sourceKeyOf({ id: native }), 'vibeshare');
    assert.equal(sourceKeyOf({ id: 'yt:abc' }), 'youtube');
    assert.equal(sourceKeyOf({ id: 'ig:p/ABC' }), 'instagram');
    assert.equal(sourceKeyOf({ id: `url:${encodeURIComponent('https://images.unsplash.com/x.jpg')}` }), 'unsplash');
    assert.equal(sourceKeyOf({ id: `url:${encodeURIComponent('https://lemmy.world/pictrs/x.png')}`, adapter: 'lemmy' }), 'lemmy');
    assert.equal(sourceKeyOf({ id: `url:${encodeURIComponent('https://blog.example/x.jpg')}` }), 'web');
  });

  it('put VibeShare content first by default and keep each source in ranking order', () => {
    const items = [{ id: 'yt:1' }, { id: 'yt:2' }, { id: 'yt:3' }, { id: native }];
    assert.deepEqual(prioritize(items, {}).map((item) => item.id), [native, 'yt:1', 'yt:2', 'yt:3']);
    assert.deepEqual(prioritize(items, { vibeshare: 5 }).map((item) => item.id), ['yt:1', 'yt:2', 'yt:3', native], 'equal priorities change nothing');
    assert.deepEqual(prioritize(items, { youtube: 0 }).map((item) => item.id), [native], '0 hides a source');
  });

  it('shape feeds and searches, and hide crawler finds of blocked sources', async () => {
    await admin(node.url(), '/v1/admin/content', { method: 'PUT', body: { id: native, title: 'Native aurora', format: 'video', publishedAt: day(1) } });
    for (let n = 2; n <= 6; n++) {
      await admin(node.url(), '/v1/admin/content', { method: 'PUT', body: { id: `yt:v${n}`, title: `Aurora ${n}`, format: 'video', publishedAt: day(n) } });
    }
    node.ingest([{ id: 'dm:found1', title: 'Aurora found', format: 'video', publishedAt: day(9), adapter: 'dailymotion' }]);
    const feed = async () => (await (await fetch(`${node.url()}/v1/feed`, { method: 'POST', body: '{}' })).json()) as Page<ContentItem>;
    let ids = (await feed()).items.map((item) => item.id.split('~')[0]);
    assert.equal(ids[0], native, 'the oldest item comes first: VibeShare outranks the rest');
    assert.equal(ids[1], 'dm:found1');

    await admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { sources: { priorities: { vibeshare: 5, youtube: 0 } }, crawler: { blockedSources: ['dailymotion'] } } });
    ids = (await feed()).items.map((item) => item.id.split('~')[0]);
    assert.deepEqual(ids, [native], 'YouTube at 0 and the blocked source\'s crawler find are gone');
    const search = (await (await fetch(`${node.url()}/v1/search`, { method: 'POST', body: JSON.stringify({ query: 'aurora' }) })).json()) as Page<ContentItem>;
    assert.deepEqual(search.items.map((item) => item.id.split('~')[0]), [native]);

    const sources = await admin<{ sources: { key: string; priority: number; blocked: boolean; listed: number; crawled: boolean }[] }>(node.url(), '/v1/admin/sources');
    const youtube = sources.sources.find((source) => source.key === 'youtube')!;
    assert.equal(youtube.priority, 0);
    assert.equal(youtube.listed, 5);
    assert.equal(youtube.crawled, true);
    assert.equal(sources.sources.find((source) => source.key === 'dailymotion')!.blocked, true);
    assert.equal(sources.sources.find((source) => source.key === 'vibeshare')!.crawled, false);
    await assert.rejects(admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { sources: { priorities: { x: 11 } } } }), /0–10/);
  });
});
