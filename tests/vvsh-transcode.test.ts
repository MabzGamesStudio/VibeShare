import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { clip } from '../src/demo/clips.js';
import { convertVvsh } from '../src/provider/vvsh.js';
import { assembleVvshWebm, type VvshBuildConfig } from '../src/shared/vvsh-encode.js';
import { parseVvshNode, type VvshHash } from '../src/shared/vvsh.js';
import { readClusterTimecode, webmClusters } from '../src/shared/webm.js';
import { startClient, startProvider, tempDir } from './helpers.js';

const CONFIG: VvshBuildConfig = {
  chunkSeconds: 3,
  previewSplits: 0,
  bitrates: [
    { id: '180p12', label: '180p12', height: 180, fps: 12, kbps: 400 },
    { id: '90p6', label: '90p6', height: 90, fps: 6, kbps: 200 },
  ],
};

async function durationOf(bytes: Uint8Array): Promise<number> {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  try {
    return await input.computeDuration();
  } finally {
    input.dispose();
  }
}

describe('the shared browser/provider variable-quality transcoder', () => {
  it('encodes distinct real renditions and assembles ordered, independently timed chunks', async () => {
    const objects = new Map<VvshHash, Uint8Array>();
    const { manifest } = await convertVvsh(clip('neon'), { name: 'qualities.vvsh', totalSeconds: 6, config: CONFIG }, (hash, data) => {
      objects.set(hash, data);
    });
    const file = manifest.vvsh!;
    assert.equal(file.meta.codec, 'vvsh-webm/1');
    assert.equal(file.meta.sourceMime, 'video/webm');
    assert.equal(file.meta.chunkCount, 2);
    assert.notEqual(file.meta.bitrates[0].bytes, file.meta.bitrates[1].bytes, 'the real encodings have different sizes');

    const chunks = [...objects.values()]
      .map((bytes) => parseVvshNode(bytes))
      .filter((node) => node?.kind === 'chunk')
      .sort((a, b) => (a!.kind === 'chunk' && b!.kind === 'chunk' ? a!.index - b!.index : 0));
    assert.equal(chunks.length, 2);
    for (const node of chunks) {
      assert.ok(node?.kind === 'chunk');
      if (node?.kind !== 'chunk') continue;
      assert.equal(new Set(node.renditions.map((leaf) => leaf.hash)).size, 2, 'quality leaves are not copies');
      for (const leaf of node.renditions) {
        const payload = objects.get(leaf.hash)!;
        const times = webmClusters(payload).map(readClusterTimecode);
        assert.deepEqual(times, times.slice().sort((a, b) => a - b), 'clusters stay ordered inside each chunk');
        assert.ok(times[0] >= node.index * 3000, 'the payload carries its global VVSH timeline');
        const preview = assembleVvshWebm(objects.get(file.meta.bitrates.find((r) => r.id === leaf.id)!.initHash!)!, [payload], {
          resetTimestamps: true,
          durationSeconds: 3,
        });
        assert.equal(readClusterTimecode(webmClusters(preview)[0]), 0, 'a chunk preview starts at zero');
        assert.ok(Math.abs((await durationOf(preview)) - 3) < 0.2, 'a chunk preview lasts only its own seconds');
      }
    }

    for (const rendition of file.meta.bitrates) {
      const ordered = chunks.map((node) => {
        assert.ok(node?.kind === 'chunk');
        if (node?.kind !== 'chunk') throw new Error('chunk expected');
        return objects.get(node.renditions.find((leaf) => leaf.id === rendition.id)!.hash)!;
      });
      const whole = assembleVvshWebm(objects.get(rendition.initHash!)!, ordered, { chunkSeconds: 3 });
      const times = webmClusters(whole).map(readClusterTimecode);
      assert.deepEqual(times, times.slice().sort((a, b) => a - b), 'the full export has no out-of-order clusters');
      assert.ok(Math.abs((await durationOf(whole)) - 6) < 0.3, 'the full export lasts the whole video');
    }
  });

  it('polls a provider conversion to completion and publishes the signed result', async () => {
    const provider = await startProvider();
    const { dir, cleanup } = tempDir();
    const { client } = await startClient(dir);
    try {
      await client.nodes.add(provider.reference());
      const node = client.nodes.list('provider')[0];
      const result = await client.core.convertVvshOn(node, {
        data: clip('neon'),
        name: 'polled.vvsh',
        totalSeconds: 6,
        config: { ...CONFIG, bitrates: CONFIG.bitrates.slice(0, 1) },
      });
      assert.equal(result.manifest.name, 'polled.vvsh');
      assert.equal(result.manifest.vvsh?.meta.chunkCount, 2);
      assert.ok(Array.isArray(result.warnings), 'retry and encoder fallback warnings travel with the result');
      assert.ok(result.manifest.creator, 'the client signs the completed provider manifest');
    } finally {
      await client.stop();
      await provider.stop();
      cleanup();
    }
  });

  it('fails instead of silently copying the source when media cannot be decoded', async () => {
    const objects = new Map<VvshHash, Uint8Array>();
    await assert.rejects(
      convertVvsh(Uint8Array.from([1, 2, 3, 4]), { name: 'broken.vvsh', totalSeconds: 6, config: CONFIG }, (hash, data) => {
        objects.set(hash, data);
      }),
      /Could not encode 180p12/
    );
    assert.equal(objects.size, 0, 'no falsely labelled tree is published');
  });
});
