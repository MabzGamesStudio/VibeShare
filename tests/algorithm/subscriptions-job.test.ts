// The background subscriptions job: loading a subscriptions feed queues every
// subscription and the job works through them a few creators per tick — one run
// bounded by creators looked up, platform calls and wall clock — while the page
// answers immediately and the crawl continues in the background. The queue persists
// (across runs and node restarts), creators checked within the refresh window are
// skipped, and a spent adapter budget stops the run cleanly. Fast and offline:
// tests/fakeweb.ts stands in for YouTube's channel feed, and one inline server
// stands in for the Instagram Graph API.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { AlgorithmConfig } from '../../src/algorithm/node.js';
import type { DeepPartial } from '../../src/node/node.js';
import { startFakeWeb } from '../fakeweb.js';
import { startAlgorithm, tempDir, waitFor } from '../helpers.js';

type SubsNode = Awaited<ReturnType<typeof startAlgorithm>>;

/** A node whose crawler is on but whose background ticker is off: the requests under
 *  test drive the job, and nothing wanders on its own. */
async function nodeWith(crawler: DeepPartial<AlgorithmConfig>['crawler'], dir: string | null = null): Promise<SubsNode> {
  const node = await startAlgorithm({ crawler: { enabled: true, allowPrivateAddresses: true, hostDelayMs: 0, ...crawler } }, dir);
  node.crawler.stop();
  return node;
}

function latest(node: SubsNode, creators: string[]): Promise<Response> {
  return fetch(`${node.url()}/v1/creators/latest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creators }),
  });
}

const yt = (site: string) => ({ youtube: { siteUrl: site, channels: ['UC1'] } });

describe('the background subscriptions job', () => {
  it('answers the page while the job keeps working in the background', async () => {
    const fw = await startFakeWeb();
    const { dir, cleanup } = tempDir();
    // One polite delay per host turn the twelve lookups into ~1.8s of work — more
    // than the request's short wait, so the page answers mid-run.
    const node = await nodeWith({ hostDelayMs: 150, adapters: yt(`${fw.url}/yt`) }, dir);
    try {
      const creators = Array.from({ length: 12 }, (_, i) => `yt:UC00${String(i + 1).padStart(2, '0')}`);
      const started = Date.now();
      const response = await latest(node, creators);
      const elapsed = Date.now() - started;
      assert.equal(response.status, 200);
      assert.ok(elapsed < 3500, `answered in ${elapsed} ms while the job was still working`);
      const atAnswer = fw.hits.get('/yt/feeds/videos.xml') ?? 0;
      assert.ok(atAnswer < 12, `only ${atAnswer} of 12 creators had been fetched when the page answered`);
      // The job keeps working after the response: the rest arrives with no new request,
      // and what the feeds carried lands in the catalog (autoList lists it).
      await waitFor(async () => (fw.hits.get('/yt/feeds/videos.xml') ?? 0) >= 12, 20_000);
      await waitFor(async () => node.registry.get('yt:longVideo01'), 5000);
      assert.equal(node.registry.get('yt:longVideo01')?.status, 'listed');
    } finally {
      await node.stop();
      cleanup();
      fw.close();
    }
  });

  it('caps each run at maxCreatorsPerRun and continues across runs and restarts', async () => {
    const fw = await startFakeWeb();
    const { dir, cleanup } = tempDir();
    const crawler = { adapters: yt(`${fw.url}/yt`), subscriptionsJob: { maxCreatorsPerRun: 6, maxCallsPerRun: 100, maxRunSeconds: 60 } };
    const creators = Array.from({ length: 20 }, (_, i) => `yt:UC1${String(i).padStart(2, '0')}`);
    let node = await nodeWith(crawler, dir);
    try {
      await latest(node, creators);
      assert.equal(fw.hits.get('/yt/feeds/videos.xml'), 6, 'one run fetches exactly its creator budget');
      assert.equal(node.crawler.status().subscriptionsJob.queued, 14, 'the rest stays queued for the next run');
      await latest(node, creators);
      assert.equal(fw.hits.get('/yt/feeds/videos.xml'), 12);
      assert.equal(node.crawler.status().subscriptionsJob.queued, 8);

      // The persisted progress survives a restart: the next run continues with the
      // eight creators still queued instead of starting over.
      await node.stop();
      node = await nodeWith(crawler, dir);
      assert.equal(node.crawler.status().subscriptionsJob.queued, 8, 'the queue survived the restart');
      await latest(node, creators);
      assert.equal(fw.hits.get('/yt/feeds/videos.xml'), 18);
      await latest(node, creators);
      assert.equal(fw.hits.get('/yt/feeds/videos.xml'), 20);
      assert.equal(node.crawler.status().subscriptionsJob.queued, 0, 'the whole list got covered across runs');
    } finally {
      await node.stop();
      cleanup();
      fw.close();
    }
  });

  it('caps each run at maxCallsPerRun', async () => {
    const fw = await startFakeWeb();
    const { dir, cleanup } = tempDir();
    const node = await nodeWith({ adapters: yt(`${fw.url}/yt`), subscriptionsJob: { maxCreatorsPerRun: 100, maxCallsPerRun: 3, maxRunSeconds: 60 } }, dir);
    try {
      const creators = Array.from({ length: 20 }, (_, i) => `yt:UC2${String(i).padStart(2, '0')}`);
      await latest(node, creators);
      assert.equal(fw.hits.get('/yt/feeds/videos.xml'), 3, 'one run makes exactly its platform-call budget');
      assert.equal(node.crawler.status().subscriptionsJob.queued, 17);
      await latest(node, creators);
      assert.equal(fw.hits.get('/yt/feeds/videos.xml'), 6);
    } finally {
      await node.stop();
      cleanup();
      fw.close();
    }
  });

  it('a spent API budget stops the job cleanly', async () => {
    // The Instagram Graph API: two calls per creator look (hashtag search + top media).
    const calls = { search: 0, media: 0 };
    const graph = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://graph');
      response.setHeader('content-type', 'application/json');
      if (url.pathname === '/ig_hashtag_search') {
        calls.search++;
        response.end(JSON.stringify({ data: [{ id: '17841' }] }));
        return;
      }
      if (url.pathname === '/17841/top_media') {
        calls.media++;
        response.end(
          JSON.stringify({
            data: [
              {
                permalink: 'https://www.instagram.com/p/ABC123xyz/',
                caption: 'Aurora over the lake #sky',
                media_type: 'IMAGE',
                media_url: 'https://cdn.example/i.jpg',
                timestamp: '2026-01-02T03:04:05Z',
                like_count: 5,
              },
            ],
          })
        );
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });
    await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;
    const instagram = { enabled: true, graphUrl: origin, accessToken: 'test-token', userId: 'test-user' };
    try {
      // An exhausted budget (nothing left today): the adapter is skipped quietly and
      // the job still finishes cleanly.
      const spent = tempDir();
      const off = await nodeWith(
        { adapters: { instagram: { ...instagram, dailyLimit: 0 }, youtube: { enabled: false } }, subscriptionsJob: { maxCreatorsPerRun: 10, maxCallsPerRun: 10, maxRunSeconds: 60 } },
        spent.dir
      );
      try {
        assert.equal((await latest(off, ['ig:ann', 'ig:bob'])).status, 200);
        assert.equal(calls.search + calls.media, 0, 'an exhausted adapter is not called at all');
        assert.equal(off.crawler.status().subscriptionsJob.queued, 0, 'its creators are skipped quietly');
        assert.equal(off.crawler.status().subscriptionsJob.running, false);
      } finally {
        await off.stop();
        spent.cleanup();
      }

      // A small budget: the calls that fit reach the network and the run stops at the
      // limit — the daily budget is respected exactly and never overshot.
      const room = tempDir();
      const node = await nodeWith(
        { adapters: { instagram: { ...instagram, dailyLimit: 4 }, youtube: { enabled: false } }, subscriptionsJob: { maxCreatorsPerRun: 10, maxCallsPerRun: 10, maxRunSeconds: 60 } },
        room.dir
      );
      try {
        const response = await latest(node, ['ig:ann', 'ig:bob', 'ig:cat', 'ig:dan']);
        assert.equal(response.status, 200);
        assert.equal(calls.search + calls.media, 4, 'exactly the daily budget of four calls reached the network');
        assert.equal(node.crawler.status().subscriptionsJob.running, false, 'the job ended cleanly at the spent budget');
      } finally {
        await node.stop();
        room.cleanup();
      }
    } finally {
      await new Promise<void>((resolve) => graph.close(() => resolve()));
    }
  });
});
