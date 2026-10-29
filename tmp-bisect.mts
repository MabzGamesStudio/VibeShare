import { clip } from './src/demo/clips.js';
import { transcodeVvshWebm } from './src/provider/transcode.js';

const source = clip('neon'); // 6s
const run = async (name: string, config: any) => {
  try {
    const webm = await transcodeVvshWebm(source, config, 6);
    console.log(name, '→ OK,', webm.v.length, 'chunks');
  } catch (e) {
    console.log(name, '→ FAIL:', (e as Error).message);
  }
};
await run('chunkSeconds 3 (test config)', { chunkSeconds: 3, previewSplits: 0, bitrates: [{ id: 'v', label: 'v', height: 180, fps: 12, kbps: 400 }] });
await run('chunkSeconds 4 (4s + 2s tail)', { chunkSeconds: 4, previewSplits: 0, bitrates: [{ id: 'v', label: 'v', height: 180, fps: 12, kbps: 400 }] });
await run('chunkSeconds 5 (5s + 1s tail)', { chunkSeconds: 5, previewSplits: 0, bitrates: [{ id: 'v', label: 'v', height: 180, fps: 12, kbps: 400 }] });
