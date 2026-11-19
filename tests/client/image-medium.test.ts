// The images medium: VibeShare-native pictures and image lists lead it — seen or not —
// and the platform pictures follow. "Image" covers image lists too (they are images
// packaged in one content), so both formats reach the medium and both are promoted,
// whatever the algorithm nodes' ranking answered and however many of them blended.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { FeedResponse, NodeEntry } from '../../src/shared/clientapi.js';
import { admin, randomBytesOf, startAlgorithm, startClient, startProvider, tempDir } from '../helpers.js';

/** Publishes real native content (the provider mints the cid) and lists it. */
async function publishListed(provider: { importBuffer(data: Buffer, options: { name: string; mime?: string }): Promise<{ cid: string }> }, algorithm: { url(): string }, title: string, format: string, seed: number): Promise<string> {
  const { cid } = await provider.importBuffer(randomBytesOf(2048 + seed, seed), { name: `${title}.bin`, mime: format === 'image' ? 'image/png' : 'application/json' });
  await admin(algorithm.url(), '/v1/admin/content', { method: 'PUT', body: { id: cid, title, format, rating: 'all', status: 'listed' } });
  return cid;
}

describe('the images medium', () => {
  it('shows seen VibeShare-native images first, platform images after', async () => {
    const { dir, cleanup } = tempDir();
    const algorithm = await startAlgorithm({}, null);
    const { client, api } = await startClient(dir);
    try {
      await api<{ added: NodeEntry[] }>('/api/nodes', { body: { text: algorithm.reference() } });
      // Four native pictures (every one of them seen) and two from a platform. The node
      // only lifts a few native items into its leading group — the rest exercises the
      // client-side ordering.
      const native = ['a', 'b', 'c', 'd'].map((letter) => `vs1${letter.repeat(52)}`);
      for (const id of [...native, 'yt:platimg001', 'yt:platimg002']) {
        await admin(algorithm.url(), '/v1/admin/content', {
          method: 'PUT',
          body: { id, title: `Picture ${id}`, format: 'image', rating: 'all', status: 'listed' },
        });
      }
      for (const id of native) await api('/api/bloom/mark', { body: { scope: 'selected', id } });

      const images = await api<FeedResponse>('/api/browse', { body: { source: 'feed', filters: { formats: ['image'] } } });
      const ids = images.items.map((item) => item.id.split('~')[0]);
      assert.equal(ids.length, 6, 'seen content is still shown in the images medium');
      for (const id of native) assert.ok(ids.slice(0, 4).includes(id), `the native ${id} leads the medium`);
      assert.ok(ids.slice(0, 4).every((id) => id.startsWith('vs1')), 'the first four are the native pictures');
      assert.deepEqual([...ids.slice(4)].sort(), ['yt:platimg001', 'yt:platimg002'], 'the platform pictures follow');
    } finally {
      await client.stop();
      await algorithm.stop();
      cleanup();
    }
  });

  it('leads with native image lists too — seen or not — and keeps them visible', async () => {
    const { dir, cleanup } = tempDir();
    const provider = await startProvider({}, join(dir, 'provider'));
    const algorithm = await startAlgorithm({}, null);
    const { client, api } = await startClient(join(dir, 'client'));
    try {
      await api<{ added: NodeEntry[] }>('/api/nodes', { body: { text: algorithm.reference() } });
      // Real published content: a native picture and a native image list the reader has
      // seen, one native picture they have not, and platform pictures/lists after them.
      const seenImage = await publishListed(provider, algorithm, 'Seen picture', 'image', 1);
      const seenList = await publishListed(provider, algorithm, 'Seen list', 'image-list', 2);
      const freshImage = await publishListed(provider, algorithm, 'Fresh picture', 'image', 3);
      for (const [id, title, format] of [
        ['yt:platimg001', 'Platform picture', 'image'],
        ['yt:platlist01', 'Platform list', 'image-list'],
      ] as const) {
        await admin(algorithm.url(), '/v1/admin/content', { method: 'PUT', body: { id, title, format, rating: 'all', status: 'listed' } });
      }
      for (const id of [seenImage, seenList]) await api('/api/bloom/mark', { body: { scope: 'selected', id } });

      // "Image" covers image lists for every client: the bare format request and the
      // GUI's aliased one bring the whole medium, the natives first.
      const natives = [seenImage, seenList, freshImage].sort();
      for (const formats of [['image'], ['image', 'image-list']]) {
        const images = await api<FeedResponse>('/api/browse', { body: { source: 'feed', filters: { formats, formatLevel: 'only' } } });
        const ids = images.items.map((item) => item.id.split('~')[0]);
        assert.deepEqual(ids.slice(0, 3).sort(), natives, `the native picture and image list lead (formats: ${formats})`);
        assert.deepEqual([...ids.slice(3)].sort(), ['yt:platimg001', 'yt:platlist01'], 'the platform pictures and lists follow');
      }
    } finally {
      await client.stop();
      await algorithm.stop();
      await provider.stop();
      cleanup();
    }
  });

  it('keeps the natives first when several algorithm nodes are blended', async () => {
    const { dir, cleanup } = tempDir();
    const first = await startAlgorithm({ name: 'One' }, null);
    const second = await startAlgorithm({ name: 'Two' }, null);
    const { client, api } = await startClient(join(dir, 'client'));
    try {
      await api<{ added: NodeEntry[] }>('/api/nodes', { body: { text: `${first.reference()}\n${second.reference()}` } });
      // One native on each node (one of them seen) and platform pictures on both — the
      // blended page must still open with the natives.
      const nativeA = 'vs1' + 'a'.repeat(52);
      const nativeB = 'vs1' + 'b'.repeat(52);
      await admin(first.url(), '/v1/admin/content', { method: 'PUT', body: { id: nativeA, title: 'List on one', format: 'image-list', rating: 'all', status: 'listed' } });
      await admin(second.url(), '/v1/admin/content', { method: 'PUT', body: { id: nativeB, title: 'Picture on two', format: 'image', rating: 'all', status: 'listed' } });
      await admin(first.url(), '/v1/admin/content', { method: 'PUT', body: { id: 'yt:p1', title: 'Platform one', format: 'image', rating: 'all', status: 'listed' } });
      await admin(second.url(), '/v1/admin/content', { method: 'PUT', body: { id: 'yt:p2', title: 'Platform two', format: 'image', rating: 'all', status: 'listed' } });
      await api('/api/bloom/mark', { body: { scope: 'selected', id: nativeA } });

      const images = await api<FeedResponse>('/api/browse', { body: { source: 'feed', filters: { formats: ['image'], formatLevel: 'only' } } });
      const ids = images.items.map((item) => item.id.split('~')[0]);
      assert.deepEqual(ids.slice(0, 2).sort(), [nativeA, nativeB].sort(), 'the natives of both nodes lead the blended page');
    } finally {
      await client.stop();
      await first.stop();
      await second.stop();
      cleanup();
    }
  });
});
