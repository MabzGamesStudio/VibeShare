import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, describe, it } from 'node:test';
import type { ContentView, FeedResponse, Job, NodeEntry, ServiceStatus } from '../src/shared/clientapi.js';
import { MiB } from '../src/shared/content.js';
import { admin, randomBytesOf, startAlgorithm, startClient, startProvider, tempDir, waitFor } from './helpers.js';

describe('a client using a provider and an algorithm node', async () => {
  const { dir, cleanup } = tempDir();
  const provider = await startProvider({
    name: 'Main CDN',
    signup: { grant: 50 },
    pricing: { perMiB: 1, freeMiBPerDay: 0 },
    storageService: { challengeIntervalSeconds: 3600 },
  });
  const empty = await startProvider({ name: 'Empty provider', signup: { grant: 50 } });
  const algorithm = await startAlgorithm({ name: 'Curator' });
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    await provider.stop();
    await empty.stop();
    await algorithm.stop();
    cleanup();
  });

  const video = randomBytesOf(Math.floor(2.5 * MiB), 7);
  let id = '';

  it('adds nodes from pasted references, rejecting bad ones', async () => {
    const text = `${provider.reference()}\n${algorithm.reference()}, not-a-ref\n${empty.url()}`;
    const result = await api<{ added: NodeEntry[]; errors: { ref: string }[] }>('/api/nodes', { body: { text } });
    assert.equal(result.added.length, 3);
    assert.deepEqual(result.errors.map((e) => e.ref), ['not-a-ref']);
    const again = await api<{ added: NodeEntry[]; errors: { error: string }[] }>('/api/nodes', { body: { text: provider.reference() } });
    assert.equal(again.errors[0].error, 'Already added');
    const wrongKey = provider.reference().replace(/vk1[a-z2-7]{52}/, algorithm.identity.id);
    const spoof = await api<{ errors: { error: string }[] }>('/api/nodes', { body: { text: wrongKey.replace('vs:provider', 'vs:algorithm') } });
    assert.match(spoof.errors[0].error, /Already added|Expected node/);
  });

  it('publishes a file to a provider and submits it to the algorithm node', async () => {
    const { fileId } = await api<{ fileId: string }>('/api/upload', { raw: video });
    const job = await api<Job>('/api/publish', {
      body: {
        fileId,
        name: 'trip.mp4',
        mime: 'video/mp4',
        title: 'Mountain trip',
        format: 'video',
        rating: 'all',
        topics: ['travel'],
        tags: ['mountains'],
        sources: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
        providers: [provider.identity.id],
        algorithms: [algorithm.identity.id],
        sign: true,
      },
    });
    const done = await waitFor(async () => {
      const current = await api<Job>(`/api/jobs/${job.id}`);
      return current.status !== 'running' && current;
    });
    assert.equal(done.status, 'done', JSON.stringify(done.steps));
    id = done.result!.id;
    assert.match(id, /^vs1[a-z2-7]{52}~yt:dQw4w9WgXcQ$/);
    assert.equal(done.steps.at(-1)!.detail, 'Waiting for review');
  });

  it('shows the content once the algorithm node lists it', async () => {
    const before = await api<FeedResponse>('/api/feed', { body: {} });
    assert.equal(before.items.length, 0);
    const pending = await admin<{ submissions: { id: string; verifiedCreator?: string }[] }>(algorithm.url(), '/v1/admin/submissions');
    assert.equal(pending.submissions[0].verifiedCreator, client.store.identity.id);
    await admin(algorithm.url(), `/v1/admin/submissions/${pending.submissions[0].id}/accept`, { body: {} });
    const feed = await api<FeedResponse>('/api/feed', { body: {} });
    assert.equal(feed.items[0].title, 'Mountain trip');
    assert.equal(feed.items[0].viaName, 'Curator');
    const search = await api<FeedResponse>('/api/search', { body: { query: 'mountain' } });
    assert.equal(search.items.length, 1);
    // The client learns its balance and the node's status from these answers; it never polls.
    const node = (await api<{ nodes: NodeEntry[] }>('/api/state')).nodes.find((n) => n.id === algorithm.identity.id)!;
    assert.equal(node.balance, algorithm.ledger.get(node.accountId!)!.balance);
    assert.equal(node.status?.online, true);
  });

  it('streams with Range requests, verifies chunks and pays the provider once', async () => {
    const view = await api<ContentView>(`/api/content/${encodeURIComponent(id)}`);
    assert.equal(view.status, 'listed');
    assert.equal(view.provider?.name, 'Main CDN');
    assert.equal(view.provider?.estimate, 3);
    assert.equal(view.manifest?.creator?.id, client.store.identity.id);
    const range = await fetch(client.url() + view.streamUrl!, { headers: { range: `bytes=${MiB - 10}-${MiB + 9}` } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes ${MiB - 10}-${MiB + 9}/${video.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), video.subarray(MiB - 10, MiB + 10));
    const whole = await fetch(client.url() + view.streamUrl!);
    assert.match(whole.headers.get('content-security-policy') ?? '', /^sandbox;/, 'untrusted content never runs in the daemon origin');
    assert.equal(whole.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), video);
    const state = await api<{ nodes: NodeEntry[] }>('/api/state');
    const balance = state.nodes.find((n) => n.id === provider.identity.id)!.balance;
    assert.equal(balance, 50 - 3, 'each chunk was paid once; the rest came from the cache');
  });

  it('fails over to the next provider in priority order', async () => {
    await api('/api/nodes/order', { body: { type: 'provider', ids: [empty.identity.id, provider.identity.id] } });
    client.fetcher.forget(id.split('~')[0]);
    const view = await api<ContentView>(`/api/content/${encodeURIComponent(id)}`);
    assert.equal(view.provider?.name, 'Main CDN');
  });

  it('falls back to the external source when no provider has it', async () => {
    await api(`/api/nodes/${provider.identity.id}`, { method: 'PATCH', body: { enabled: false } });
    client.fetcher.forget(id.split('~')[0]);
    const view = await api<ContentView>(`/api/content/${encodeURIComponent(id)}`);
    assert.equal(view.manifest, undefined);
    assert.equal(view.embeds[0].kind, 'iframe');
    assert.equal(view.embeds[0].src, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    assert.ok(view.providerErrors.some((e) => e.name === 'Empty provider' && e.error === 'Does not have it'));
    await api(`/api/nodes/${provider.identity.id}`, { method: 'PATCH', body: { enabled: true } });
  });

  it('skips providers above the price limit', async () => {
    await api(`/api/nodes/${provider.identity.id}`, { method: 'PATCH', body: { maxPrice: 0 } });
    client.fetcher.forget(id.split('~')[0]);
    const view = await api<ContentView>(`/api/content/${encodeURIComponent(id)}`);
    assert.ok(view.providerErrors.some((e) => e.error === 'Above your price limit'));
    await api(`/api/nodes/${provider.identity.id}`, { method: 'PATCH', body: { maxPrice: null } });
  });

  it('earns credits by storing data for the provider', async () => {
    const cid = id.split('~')[0];
    await admin(provider.url(), '/v1/admin/storage/jobs', {
      body: { cid, replicas: 1, durationDays: 30, rewards: { upfront: 5, perRetrieval: 2, perChallenge: 1, completion: 10 } },
    });
    await api('/api/settings', { method: 'PATCH', body: { storageService: { enabled: true, quotaGiB: 1 } } });
    await api('/api/nodes/refresh', { method: 'POST' });
    await api('/api/services/sync', { method: 'POST' });
    const before = provider.ledger.get((await api<{ nodes: NodeEntry[] }>('/api/state')).nodes.find((n) => n.id === provider.identity.id)!.accountId!)!.balance;
    // the first challenge is sent as soon as the data is stored; passing it pays upfront + challenge
    await waitFor(async () => {
      const status = await api<ServiceStatus>('/api/services');
      const mine = status.providers.find((p) => p.id === provider.identity.id);
      return mine?.assignments[0]?.status === 'active' && status.usedBytes === video.length;
    });
    await waitFor(() => provider.service.assignmentsForAdmin()[0]?.challenges.passed >= 1);
    const accountId = provider.service.assignmentsForAdmin()[0].accountId;
    assert.equal(provider.ledger.get(accountId)!.balance, before + 6);

    // The provider loses its own copy: it asks the client for the chunk and pays for the retrieval.
    const manifest = provider.store.getManifest(cid)!;
    const chunkId = manifest.chunks[1].id;
    for (const backend of provider.backends()) await backend.delete(chunkId);
    (provider.store as unknown as { cache: { delete(id: string): void } }).cache.delete(chunkId);
    const data = await provider.store.getChunk(chunkId);
    assert.ok(data);
    assert.equal(provider.ledger.get(accountId)!.balance, before + 8);
  });

  it('votes on content through the algorithm node, and the GUI hears of the new balance at once', async () => {
    // The GUI's live feed of node changes (Server-Sent Events from the daemon).
    const events = await fetch(client.url() + '/api/events', { headers: { 'x-vs-token': client.token } });
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const nextNodes = async () => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (block.startsWith('event: nodes') && data) return JSON.parse(data.slice(6)) as NodeEntry[];
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('events ended');
        buffer += value;
      }
    };
    const balanceOn = (nodes: NodeEntry[]) => nodes.find((n) => n.id === algorithm.identity.id)!.balance;
    const initial = balanceOn(await nextNodes());

    const result = await api<{ likes: number; credited: number }>('/api/vote', {
      body: { nodeId: algorithm.identity.id, id, vote: 1 },
    });
    assert.deepEqual([result.likes, result.credited], [1, 1]);
    assert.equal(balanceOn(await nextNodes()), (initial ?? 0) + 1, 'the reward shows up without anyone asking');
    await reader.cancel();
  });

  it('rejects requests without the local token or with a foreign Host', async () => {
    const noToken = await fetch(client.url() + '/api/state');
    assert.equal(noToken.status, 403);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(client.url() + '/api/state', { headers: { 'x-vs-token': client.token, host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403, 'DNS rebinding is refused');
  });
});
