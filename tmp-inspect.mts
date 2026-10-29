import { readFileSync } from 'node:fs';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { splitWebm, readClusterTimecode, clusterTimecodeWidth, webmClusters } from './src/shared/webm.js';
import { buildVvsh, normalizeVvshWebmChunk } from './src/shared/vvsh-encode.js';
import { parseVvshNode } from './src/shared/vvsh.js';

const chunks = [0, 1, 2].map((i) => new Uint8Array(readFileSync('/tmp/mrtest/chunk' + i + '.webm')));
for (const [i, bytes] of chunks.entries()) {
  const { clusters, timecodeScale } = splitWebm(bytes);
  console.log(`recording ${i}: scale=${timecodeScale} local cluster times =`, clusters.map((c) => readClusterTimecode(c) + '/w' + clusterTimecodeWidth(c)));
}
const config = { chunkSeconds: 1, previewSplits: 0, bitrates: [{ id: 'v', label: 'v', height: 240, fps: 30, kbps: 400 }] };
const objects = new Map<string, Uint8Array>();
const { file } = await buildVvsh(new Uint8Array(0), { totalSeconds: 3, config, sourceMime: 'video/webm', webm: { v: chunks } }, (hash, data) => void objects.set(hash, data));
const leaves: { index: number; hash: string }[] = [];
const walk = (hash: string) => {
  const node = parseVvshNode(objects.get(hash)!);
  if (node?.kind === 'chunk') leaves.push({ index: node.index, hash: node.renditions.find((r) => r.id === 'v')!.hash });
  else if (node?.kind === 'branch') { walk(node.left); walk(node.right); }
};
walk(file.root);
leaves.sort((a, b) => a.index - b.index);
for (const leaf of leaves) {
  const norm = normalizeVvshWebmChunk(objects.get(leaf.hash)!, leaf.index, 1);
  console.log(`payload chunk ${leaf.index}: cluster times =`, webmClusters(norm).map(readClusterTimecode));
}
const init = objects.get(file.meta.bitrates[0].initHash!)!;
const body = leaves.map((leaf) => normalizeVvshWebmChunk(objects.get(leaf.hash)!, leaf.index, 1));
const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const input = new Input({ source: new BufferSource(concat([init, ...body])), formats: ALL_FORMATS });
console.log('MSE-assembled duration =', await input.computeDuration(), 's (expected 3)');
input.dispose();
