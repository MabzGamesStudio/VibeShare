// The operator's real flow into the images medium: publish an image and an image list
// through the client API exactly as the GUI does (raw upload + /api/publish), take both
// past the review queues the real chain has — the provider keeps pushed content pending
// review until accepted, and the algorithm queues submissions for the operator — then
// the images medium must lead with them. Seen (previewed) or not, a just-published
// native picture stays in the medium and stays first, and the client serves the image
// list's bytes once accepted. The earlier tests listed content straight through the
// admin route and never touched this chain; this is the regression test for the report
// "published images and image lists are not recommended in the images medium".
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { FeedResponse, Job, NodeEntry, Settings } from '../../src/shared/clientapi.js';
import { IMAGE_LIST_MIME, packImageList } from '../../src/shared/image-list.js';
import { admin, randomBytesOf, startAlgorithm, startClient, startProvider, tempDir, waitFor } from '../helpers.js';

/** One tiny but real PNG (1×1), so the published image is image bytes all the way. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000003715dc' +
    '920000000d4944415478da63f8cf400f0005c202fef2a1a1f90000000049454e44ae426082',
  'hex'
);

describe('published images in the images medium (the operator flow)', () => {
  it('publishes an image and an image list, accepts them, and leads the medium with them', async () => {
    const { dir, cleanup } = tempDir();
    const provider = await startProvider({}, join(dir, 'provider'));
    const algorithm = await startAlgorithm({}, null);
    const { client, api } = await startClient(join(dir, 'client'));
    try {
      await api<{ added: NodeEntry[] }>('/api/nodes', { body: { text: provider.reference() } });
      await api<{ added: NodeEntry[] }>('/api/nodes', { body: { text: algorithm.reference() } });
      const state = await api<{ nodes: NodeEntry[] }>('/api/state');
      const providerId = state.nodes.find((node) => node.type === 'provider')!.id;
      const algorithmId = state.nodes.find((node) => node.type === 'algorithm')!.id;

      // Publish exactly as the client GUI does: raw upload, then /api/publish against
      // the provider and the algorithm node.
      const publish = async (title: string, mime: string, format: 'image' | 'image-list', bytes: Buffer): Promise<string> => {
        const upload = await api<{ fileId: string; size: number }>('/api/upload', { method: 'POST', raw: bytes });
        const job = await api<Job>('/api/publish', {
          body: {
            fileId: upload.fileId,
            name: `${title.toLowerCase().replace(/\W+/g, '-')}${format === 'image-list' ? '.vslist' : '.png'}`,
            mime,
            title,
            format,
            rating: 'all',
            providers: [providerId],
            algorithms: [algorithmId],
            sign: false,
          },
        });
        const done = await waitFor(async () => {
          const current = await api<Job>(`/api/jobs/${job.id}`);
          if (current.status === 'error') assert.fail(`the publish job failed: ${current.error}`);
          return current.status === 'done' ? current : false;
        });
        return String((done.result as { id: string }).id);
      };

      const listBytes = Buffer.from(packImageList([
        { name: 'one.png', mime: 'image/png', data: PNG },
        { name: 'two.png', mime: 'image/png', data: new Uint8Array(randomBytesOf(2048, 7)) },
      ]));
      const imageId = await publish('Published picture', 'image/png', 'image', PNG);
      const listId = await publish('Published list', IMAGE_LIST_MIME, 'image-list', listBytes);
      const [imageCid, listCid] = [imageId, listId].map((id) => id.split('~')[0]);

      // The real chain leaves both behind review gates. Provider first: pushed content
      // is invisible there until the operator accepts it from the review queue.
      const review = await admin<{ items: { cid: string }[] }>(provider.url(), '/v1/admin/content/review');
      assert.deepEqual(review.items.map((item) => item.cid).sort(), [imageCid, listCid].sort(), 'both uploads wait in the provider review queue');
      for (const cid of [imageCid, listCid]) {
        await admin(provider.url(), `/v1/admin/content/${cid}/accept`, { method: 'POST', body: {} });
      }
      // Then the algorithm: submissions land pending review (auto-list is off by
      // default — that part is policy) until the operator accepts them.
      const submissions = await admin<{ submissions: { id: string; contentId: string; status: string }[] }>(
        algorithm.url(),
        '/v1/admin/submissions'
      );
      assert.equal(submissions.submissions.length, 2, 'both submissions wait for the operator');
      for (const submission of submissions.submissions) {
        await admin(algorithm.url(), `/v1/admin/submissions/${submission.id}/accept`, { method: 'POST', body: {} });
      }

      // The images medium, requested exactly as the GUI's image chip and the bare
      // format request do it.
      const natives = [imageCid, listCid].sort();
      for (const formats of [['image', 'image-list'], ['image']] as const) {
        const images = await api<FeedResponse>('/api/browse', {
          body: { source: 'feed', filters: { formats: [...formats], formatLevel: 'only' } },
        });
        const ids = images.items.map((item) => item.id.split('~')[0]);
        assert.deepEqual(ids.slice(0, 2).sort(), natives, `the published natives lead the medium (formats: ${formats})`);
      }

      // The reader sees them (the GUI marks previews on screen; opening marks selected).
      // A just-published native still leads the medium on the next browse — being seen
      // must not filter it out of the images medium.
      for (const id of [imageId, listId]) {
        await api('/api/bloom/mark', { body: { scope: 'preview', id } });
        await api('/api/bloom/mark', { body: { scope: 'selected', id } });
      }
      const again = await api<FeedResponse>('/api/browse', {
        body: { source: 'feed', filters: { formats: ['image', 'image-list'], formatLevel: 'only' } },
      });
      const seenIds = again.items.map((item) => item.id.split('~')[0]);
      assert.deepEqual(seenIds.slice(0, 2).sort(), natives, 'seen natives still lead the medium');

      // And the bytes come back: provider review must not silently block serving them.
      const served = await fetch(`${client.url()}/stream/${listCid}?download=1`, { headers: { 'x-vs-token': client.token } });
      assert.ok(served.ok, 'the accepted image list serves its bytes');
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), listBytes, 'the image list bytes are exactly what was published');
    } finally {
      await client.stop();
      await algorithm.stop();
      await provider.stop();
      cleanup();
    }
  });

  it('keeps every published native in the medium once the reader has seen it', async () => {
    // The reported shape of the bug: an operator with a catalog of published pictures
    // (more than the node's small leading native group) turns on the seen-content
    // filter and publishes more. The images medium is documented to lead with
    // VibeShare-native pictures "seen or not" — but once a picture is seen and the
    // seen filter travels to the node, the node drops every native beyond its leading
    // group before the client's exemption ever sees it. With seen filters on, the
    // medium must keep all of them, first.
    const { dir, cleanup } = tempDir();
    const provider = await startProvider({}, join(dir, 'provider'));
    const algorithm = await startAlgorithm({}, null);
    const { client, api } = await startClient(join(dir, 'client'));
    try {
      await api<{ added: NodeEntry[] }>('/api/nodes', { body: { text: provider.reference() } });
      await api<{ added: NodeEntry[] }>('/api/nodes', { body: { text: algorithm.reference() } });
      await api<{ settings: Settings }>('/api/settings', { method: 'PATCH', body: { searchBloom: { enabled: true, bits: 10_000, expected: 1000 } } });
      const state = await api<{ nodes: NodeEntry[] }>('/api/state');
      const providerId = state.nodes.find((node) => node.type === 'provider')!.id;
      const algorithmId = state.nodes.find((node) => node.type === 'algorithm')!.id;

      const publish = async (title: string, mime: string, format: 'image' | 'image-list', bytes: Buffer): Promise<string> => {
        const upload = await api<{ fileId: string; size: number }>('/api/upload', { method: 'POST', raw: bytes });
        const job = await api<Job>('/api/publish', {
          body: {
            fileId: upload.fileId,
            name: `${title.toLowerCase().replace(/\W+/g, '-')}${format === 'image-list' ? '.vslist' : '.png'}`,
            mime,
            title,
            format,
            rating: 'all',
            providers: [providerId],
            algorithms: [algorithmId],
            sign: false,
          },
        });
        const done = await waitFor(async () => {
          const current = await api<Job>(`/api/jobs/${job.id}`);
          if (current.status === 'error') assert.fail(`the publish job failed: ${current.error}`);
          return current.status === 'done' ? current : false;
        });
        return String((done.result as { id: string }).id);
      };

      // Five pictures and four lists — past the node's leading group (three per
      // format), so some of them only travel with the ordinary results.
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await publish(`Picture ${i}`, 'image/png', 'image', Buffer.concat([PNG, Buffer.from([i])])));
      for (let i = 0; i < 4; i++) {
        const bytes = Buffer.from(packImageList([{ name: `${i}.png`, mime: 'image/png', data: new Uint8Array(randomBytesOf(1024, 10 + i)) }]));
        ids.push(await publish(`List ${i}`, IMAGE_LIST_MIME, 'image-list', bytes));
      }
      const cids = ids.map((id) => id.split('~')[0]);

      // The operator takes them live: provider review accept + algorithm submission accept.
      for (const cid of cids) await admin(provider.url(), `/v1/admin/content/${cid}/accept`, { method: 'POST', body: {} });
      const submissions = await admin<{ submissions: { id: string }[] }>(algorithm.url(), '/v1/admin/submissions');
      assert.equal(submissions.submissions.length, 9, 'every submission waits for the operator');
      for (const submission of submissions.submissions) {
        await admin(algorithm.url(), `/v1/admin/submissions/${submission.id}/accept`, { method: 'POST', body: {} });
      }

      const medium = async () => {
        const images = await api<FeedResponse>('/api/browse', {
          body: { source: 'feed', filters: { formats: ['image', 'image-list'], formatLevel: 'only' } },
        });
        return images.items.map((item) => item.id.split('~')[0]);
      };

      // First browse: the reader sees all of them (the GUI marks previews on screen).
      const first = await medium();
      for (const cid of cids) assert.ok(first.includes(cid), `${cid.slice(0, 16)}… is in the medium`);
      assert.deepEqual(first.slice(0, 9).sort(), cids.sort(), 'the natives lead the medium');
      for (const id of ids) await api('/api/bloom/mark', { body: { scope: 'preview', id } });

      // Once seen: the medium still leads with every native picture, seen or not.
      const again = await medium();
      for (const cid of cids) assert.ok(again.includes(cid), `${cid.slice(0, 16)}… is still in the medium after being seen`);
      assert.deepEqual(again.slice(0, 9).sort(), [...cids].sort(), 'seen natives still lead the medium');
    } finally {
      await client.stop();
      await algorithm.stop();
      await provider.stop();
      cleanup();
    }
  });
});
