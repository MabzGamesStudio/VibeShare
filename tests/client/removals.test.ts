// Library removal actions: the per-node "request removal" proxy (each node answers for
// itself) and "delete locally" (one content's cached chunks out of the local cache).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { NodeEntry } from '../../src/shared/clientapi.js';
import { randomBytesOf, startAlgorithm, startClient, startProvider, tempDir } from '../helpers.js';

describe('library removal actions', async () => {
  const { dir, cleanup } = tempDir();
  const provider = await startProvider({}, join(dir, 'provider'));
  const algorithm = await startAlgorithm({}, null);
  const { client, api } = await startClient(join(dir, 'client'));
  after(async () => {
    await client.stop();
    await algorithm.stop();
    await provider.stop();
    cleanup();
  });
  const added = await api<{ added: NodeEntry[] }>('/api/nodes', { body: { text: `${algorithm.reference()}\n${provider.reference()}` } });

  it('sends a removal request to the chosen nodes and reports each answer', async () => {
    const nodeId = added.added[0].id;
    // The nodes' own endpoint lands in parallel: whether this node accepts the request
    // or does not know it yet, the proxy reports it per node and never fails as a whole.
    const answer = await api<{ results: { node: string; name: string; ok: boolean; error?: string }[] }>('/api/removals', {
      method: 'POST',
      body: { nodeIds: [nodeId, 'vs:nosuchnode'], id: 'yt:video1', message: 'Please remove this' },
    });
    assert.equal(answer.results.length, 2);
    assert.equal(answer.results[0].node, nodeId, 'the configured node answers first');
    assert.equal(typeof answer.results[0].ok, 'boolean', 'a configured node is reported sent or failed');
    if (!answer.results[0].ok) assert.ok(answer.results[0].error, 'a failure says why');
    assert.equal(answer.results[1].ok, false, 'an unknown node is reported as failed');
    assert.match(answer.results[1].error ?? '', /unknown node/i);
  });

  it('deletes one content’s cached chunks on "delete locally"', async () => {
    const { cid } = await provider.importBuffer(randomBytesOf(300_000, 7), { name: 'clip.bin' });
    const stream = await fetch(`${client.url()}/stream/${cid}?t=${client.token}`);
    assert.equal(stream.status, 200);
    await stream.arrayBuffer(); // the content's chunks land in the local cache
    const before = await api<{ chunks: number }>('/api/cache');
    assert.ok(before.chunks > 0, 'the download was cached');
    const dropped = await api<{ dropped: number }>(`/api/cache/${encodeURIComponent(cid)}`, { method: 'DELETE' });
    assert.equal(dropped.dropped, before.chunks, "every cached chunk of the content was dropped");
    const after = await api<{ chunks: number }>('/api/cache');
    assert.equal(after.chunks, 0, 'and nothing of it is kept');
    // Dropping again (or dropping something never cached) is harmless.
    const again = await api<{ dropped: number }>(`/api/cache/${encodeURIComponent(cid)}`, { method: 'DELETE' });
    assert.equal(again.dropped, 0);
  });
});
