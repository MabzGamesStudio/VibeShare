import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { clip } from './src/demo/clips.js';
import { transcodeVvshWebm } from './src/provider/transcode.js';
import { buildVvsh, normalizeVvshWebmChunk } from './src/shared/vvsh-encode.js';
import { parseVvshNode } from './src/shared/vvsh.js';
import { readClusterTimecode, webmClusters } from './src/shared/webm.js';

const source = clip('neon'); // 6s, user's shape: chunks 4s + 2s tail
const config = { chunkSeconds: 4, previewSplits: 0, bitrates: [{ id: 'v', label: 'v', height: 180, fps: 12, kbps: 400, width: 320, fit: 'crop' as const }] };
const webm = await transcodeVvshWebm(source, config, 6);
const objects = new Map<string, Uint8Array>();
const { file } = await buildVvsh(new Uint8Array(0), { totalSeconds: 6, config, sourceMime: 'video/webm', webm }, (hash, data) => void objects.set(hash, data));
console.log('meta.chunkCount =', file.meta.chunkCount, 'chunkSeconds =', file.meta.chunkSeconds);
const leaves: { index: number; hash: string }[] = [];
const walk = (hash: string) => {
  const node = parseVvshNode(objects.get(hash)!);
  if (node?.kind === 'chunk') leaves.push({ index: node.index, hash: node.renditions.find((r) => r.id === 'v')!.hash });
  else if (node?.kind === 'branch') { walk(node.left); walk(node.right); }
};
walk(file.root);
leaves.sort((a, b) => a.index - b.index);
for (const leaf of leaves) {
  const normalized = normalizeVvshWebmChunk(objects.get(leaf.hash)!, leaf.index, file.meta.chunkSeconds);
  console.log(`chunk ${leaf.index}: cluster times =`, webmClusters(normalized).map(readClusterTimecode));
}
const init = objects.get(file.meta.bitrates[0].initHash!)!;
const body = leaves.map((leaf) => normalizeVvshWebmChunk(objects.get(leaf.hash)!, leaf.index, file.meta.chunkSeconds));
const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const input = new Input({ source: new BufferSource(concat([init, ...body])), formats: ALL_FORMATS });
console.log('MSE-assembled duration =', await input.computeDuration(), 's (expected 6)');
input.dispose();
