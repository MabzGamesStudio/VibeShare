// Subscribed creators are looked up on their own platforms when the subscriptions
// feed is loaded: the request answers with what has landed within its short wait,
// the lookups continue in the background, and each creator is re-checked only every
// crawler.creatorRefreshHours. Fast and offline: tests/fakeweb.ts stands in for
// YouTube's channel feed.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { startFakeWeb } from '../fakeweb.js';
import { startAlgorithm, tempDir } from '../helpers.js';

type SubscriptionsNode = Awaited<ReturnType<typeof startAlgorithm>>;

/** A node whose crawler is on (pointed at `origin`) but whose background ticker is off. */
async function subscriptionsNode(youtubeSite: string): Promise<{ node: SubscriptionsNode; cleanup: () => void }> {
  const { dir, cleanup } = tempDir();
  const node = await startAlgorithm(
    {
      crawler: {
        enabled: true,
        allowPrivateAddresses: true,
        // No polite host spacing in tests: production keeps it and the background
        // finish covers lookups that outlast the request's short wait.
        hostDelayMs: 0,
        adapters: { youtube: { siteUrl: youtubeSite, channels: ['UC1'] } },
      },
    },
    dir
  );
  node.crawler.stop(); // the requests under test drive the lookups; no wandering ticks
  return {
    node,
    cleanup: async () => {
      await node.stop();
      cleanup();
    },
  };
}

async function latest(node: SubscriptionsNode, creators: string[]): Promise<Response> {
  return fetch(`${node.url()}/v1/creators/latest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creators }),
  });
}

describe('subscription creator refresh', () => {
  it('brings a subscribed creator’s platform content in', async () => {
    const fw = await startFakeWeb();
    const { node, cleanup } = await subscriptionsNode(`${fw.url}/yt`);
    try {
      const response = await latest(node, ['yt:UC1']);
      assert.equal(response.status, 200);
      // The channel feed's video is in the catalog (autoList decides it is listed),
      // tagged with the id the client subscribed to.
      const entry = node.registry.get('yt:longVideo01');
      assert.ok(entry, 'the channel feed video reached the catalog');
      assert.equal(entry.status, 'listed');
      assert.equal(entry.creatorId, 'yt:UC1');

      // …and the next subscriptions answer carries it.
      const page = (await (await latest(node, ['yt:UC1'])).json()) as { items: { id: string }[] };
      assert.ok(page.items.some((item) => item.id.startsWith('yt:longVideo01')));
    } finally {
      await cleanup();
      fw.close();
    }
  });

  it('does not fetch a creator again inside the refresh window', async () => {
    const fw = await startFakeWeb();
    const { node, cleanup } = await subscriptionsNode(`${fw.url}/yt`);
    try {
      await latest(node, ['yt:UC1']);
      await latest(node, ['yt:UC1']);
      await latest(node, ['yt:UC1']);
      // One fetch of the channel feed for three page loads (creatorRefreshHours).
      assert.equal(fw.hits.get('/yt/feeds/videos.xml'), 1);
    } finally {
      await cleanup();
      fw.close();
    }
  });

  it('takes creators without a platform in stride', async () => {
    const fw = await startFakeWeb();
    const { node, cleanup } = await subscriptionsNode(`${fw.url}/yt`);
    try {
      // A native key and a catalog name have no platform to ask — the batch still
      // completes for the creator that has one.
      const response = await latest(node, [`vk1${'a'.repeat(52)}`, 'name:studio', 'yt:UC1']);
      assert.equal(response.status, 200);
      assert.ok(node.registry.get('yt:longVideo01'), 'the refreshable creator was still checked');
    } finally {
      await cleanup();
      fw.close();
    }
  });

  it('answers within the timeout even when a platform hangs', async () => {
    // A server that accepts connections and never answers.
    const sockets = new Set<import('node:net').Socket>();
    const black: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => black.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(black.address() as AddressInfo).port}`;
    const { node, cleanup } = await subscriptionsNode(origin);
    try {
      const started = Date.now();
      const response = await latest(node, ['yt:UC1']);
      const elapsed = Date.now() - started;
      assert.equal(response.status, 200);
      assert.ok(elapsed < 3500, `answered in ${elapsed} ms despite the hanging platform`);
    } finally {
      await cleanup();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => black.close(() => resolve()));
    }
  });
});
