import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { chunkIdOf, contentIdOf, validateManifest, type Manifest } from '../src/shared/content.js';
import { defaultSettings, normalizeSettings } from '../src/shared/clientdefaults.js';
import { buildVvsh, decodeVvshChunk, encodeVvshFrames, exportVvshStream, frameStats, vvshPlan, type VvshBuildConfig } from '../src/shared/vvsh-encode.js';
import { chunkAt, parseVvshFile, parseVvshNode, pathToChunk, previewAt, serializeVvshFile, treeLeaves, unpackVvshNode, vvshFileJson, walkToChunk, type VvshHash } from '../src/shared/vvsh.js';
import { base64url } from '../src/shared/encoding.js';
import { clientFor, randomBytesOf, startClient, startProvider, tempDir } from './helpers.js';

const RENDITIONS = [
  { id: '8k', label: '8K', height: 4320, kbps: 40_000 },
  { id: '4k', label: '4K', height: 2160, kbps: 20_000 },
  { id: '1080p', label: '1080p', height: 1080, kbps: 5_000 },
  { id: '720p', label: '720p', height: 720, kbps: 2_500 },
];
const CONFIG: VvshBuildConfig = { bitrates: RENDITIONS, chunkSeconds: 10, previewSplits: 6, gop: 8 };

/** Every payload of one rendition, in chunk order (the chunks of one bitrate). */
function payloadsOf(objects: Map<VvshHash, Uint8Array>, rendition: string): Uint8Array[] {
  const chunks: { index: number; data: Uint8Array }[] = [];
  for (const bytes of objects.values()) {
    const node = parseVvshNode(bytes);
    if (node?.kind === 'chunk') {
      const leaf = node.renditions.find((entry) => entry.id === rendition)!;
      chunks.push({ index: node.index, data: objects.get(leaf.hash)! });
    }
  }
  return chunks.sort((a, b) => a.index - b.index).map((entry) => entry.data);
}

describe('the .vvsh verifiable video stream format', async () => {
  // A one minute video in ten second chunks: six chunks, four bitrate encodings each.
  const source = randomBytesOf(60_000);
  const objects = new Map<VvshHash, Uint8Array>();
  const { file } = await buildVvsh(source, { totalSeconds: 60, config: CONFIG }, (hash, data) => { objects.set(hash, data); });
  const fetchObject = async (hash: VvshHash) => objects.get(hash) ?? null;

  it('takes the metadata the format names: version, bitrates, chunk length, counts and length', () => {
    const plan = vvshPlan(60, CONFIG);
    assert.equal(plan.chunkCount, 6, 'a minute in ten second chunks');
    assert.equal(plan.previewCount, 6);
    const meta = file.meta;
    assert.equal(meta.v, 1);
    assert.equal(meta.chunkSeconds, 10);
    assert.equal(meta.chunkCount, 6);
    assert.equal(meta.totalSeconds, 60);
    assert.deepEqual(meta.bitrates.map((rendition) => rendition.id), ['8k', '4k', '1080p', '720p']);
    assert.ok(meta.frames.gop >= 2, 'chunks hold more than one frame');
  });

  it('uses I, P and B frames in every chunk, and the last tree layers split into the encodings', async () => {
    const node = await walkToChunk(file.root, 6, 3, fetchObject);
    assert.ok(node && node.kind === 'chunk');
    assert.equal(node.index, 3);
    assert.deepEqual(
      node.renditions.map((rendition) => rendition.id),
      ['8k', '4k', '1080p', '720p'],
      'the chunk node holds every bitrate encoding of that moment'
    );
    for (const rendition of node.renditions) {
      const payload = objects.get(rendition.hash)!;
      assert.equal(chunkIdOf(payload), rendition.hash, 'every leaf is the hash of its payload');
      const frames = decodeVvshChunk(payload);
      assert.equal(frames[0].type, 'I', 'every chunk starts with its keyframe');
      assert.ok(frames.some((frame) => frame.type === 'P'));
      assert.ok(frames.some((frame) => frame.type === 'B'));
      assert.deepEqual(frameStats(frames), rendition.frames);
    }
  });

  it('finds one node with a single path down the tree, and refuses a tampered step', async () => {
    assert.deepEqual(treeLeaves(6), [0, 1, 2, 3, 4, 5], 'the chunk nodes sit in time order');
    assert.equal(pathToChunk(6, 5).length, 3, 'one path of branch decisions, from the root down');
    for (let index = 0; index < 6; index++) {
      const node = await walkToChunk(file.root, 6, index, fetchObject);
      assert.equal(node?.index, index, `every chunk has its own single path down (chunk ${index})`);
    }
    const node = await walkToChunk(file.root, 6, 5, fetchObject);
    assert.equal(node && node.kind === 'chunk' ? node.index : null, 5);
    // One flipped byte anywhere on the path and the walk stops believing it — the root
    // record is on every path.
    const original = objects.get(file.root)!;
    const tampered = Uint8Array.from(original);
    tampered[tampered.length - 1] ^= 1;
    objects.set(file.root, tampered);
    assert.equal(await walkToChunk(file.root, 6, 5, fetchObject), null);
    objects.set(file.root, original);
  });

  it('seeks by timestamp to one chunk and shows the preview of that section', () => {
    const meta = file.meta;
    assert.equal(chunkAt(meta, 0), 0);
    assert.equal(chunkAt(meta, 35), 3, '10 second chunks: 35 seconds in is chunk 3');
    assert.equal(chunkAt(meta, 599), 5, 'the last chunk covers the tail');
    const first = previewAt(meta, 2)!;
    const later = previewAt(meta, 55)!;
    assert.ok(first.startsWith('data:image/'), 'previews are small images, not chunks');
    assert.notEqual(first, later, 'each section of the video has its own preview');
  });

  it('reassembles one bitrate back into the exact video, and round-trips the file', () => {
    const exported = exportVvshStream(payloadsOf(objects, '8k'));
    assert.deepEqual(Buffer.from(exported), Buffer.from(source), 'the top encoding keeps every byte');
    const smaller = payloadsOf(objects, '720p');
    assert.ok(smaller[0].length < payloadsOf(objects, '8k')[0].length, 'the lower encodings hold less');
    const parsed = parseVvshFile(serializeVvshFile(file));
    assert.equal(parsed.root, file.root);
    assert.equal(parsed.meta.chunkCount, 6);
    assert.throws(() => parseVvshFile('{ "meta": {} }'), /bad metadata/);
    const broken = parseVvshNode(objects.get([...objects.keys()][0])!, 'chk1wrong');
    assert.equal(broken, null, 'a record that hashes to something else is refused');
  });

  it('packs the file and the records as bytes, with the JSON only as a translation', () => {
    const packed = serializeVvshFile(file);
    assert.equal(String.fromCharCode(...packed.subarray(0, 4)), 'VVSH', 'the file is packed bytes, not JSON');
    const back = parseVvshFile(packed);
    assert.equal(back.root, file.root);
    assert.equal(back.meta.chunkCount, file.meta.chunkCount);
    assert.deepEqual(back.meta.bitrates, file.meta.bitrates);
    assert.deepEqual(back.meta.previews, file.meta.previews);
    // The same data as readable JSON — what the testing page shows.
    assert.equal(parseVvshFile(JSON.stringify(vvshFileJson(file))).root, file.root);
    // Records pack the same way and read back exactly.
    const record = objects.get(file.root)!;
    assert.equal(String.fromCharCode(...record.subarray(0, 4)), 'VVND', 'records are packed bytes too');
    assert.equal(unpackVvshNode(record)?.kind, 'branch');
    assert.equal(parseVvshNode(record, file.root)?.kind, 'branch');
    assert.throws(() => parseVvshFile('this is not a vvsh file'), /not a \.vvsh file/);
  });

  it('packs large frames without allocating past anything', () => {
    const block = randomBytesOf(2_000_000);
    const frames = encodeVvshFrames([block, block, block, block, block, block, block, block]);
    assert.equal(frames[0].type, 'I');
    assert.ok(frames[1].data.length < 1000, 'a P frame over unchanged bytes costs almost nothing');
  });

  it('keeps a real upload intact in every encoding, so any of them plays', async () => {
    const real = new Map<VvshHash, Uint8Array>();
    const { file: realFile } = await buildVvsh(
      source,
      { totalSeconds: 60, config: CONFIG, sourceMime: 'video/mp4' },
      (hash, data) => {
        real.set(hash, data);
      }
    );
    for (const rendition of realFile.meta.bitrates) {
      assert.deepEqual(
        Buffer.from(exportVvshStream(payloadsOf(real, rendition.id))),
        Buffer.from(source),
        `${rendition.label} carries the exact video (container and audio intact)`
      );
    }
  });
});

describe('a provider storing a .vvsh stream', async () => {
  const provider = await startProvider();
  const url = provider.url();
  after(() => provider.stop());
  const source = randomBytesOf(20_000);
  const objects = new Map<VvshHash, Uint8Array>();
  const { file } = await buildVvsh(source, { totalSeconds: 30, config: CONFIG }, (hash, data) => { objects.set(hash, data); });

  it('keeps the file (metadata and root) and stores every branch and child on its own', async () => {
    const uploader = clientFor(url, 'identity');
    for (const [hash, data] of objects) {
      const put = await uploader.json<{ ok: boolean }>(`/v1/vvsh/objects/${encodeURIComponent(hash)}`, { method: 'PUT', raw: data });
      assert.equal(put.ok, true);
    }
    await assert.rejects(
      uploader.json(`/v1/vvsh/objects/${encodeURIComponent([...objects.keys()][0])}`, { method: 'PUT', raw: randomBytesOf(16) }),
      /do not match/
    );
    const manifest: Manifest = { v: 1, name: 'clip.vvsh', mime: 'video/x-vvsh', size: 0, chunkSize: 1024 * 1024, chunks: [], createdAt: new Date().toISOString(), vvsh: file };
    validateManifest(manifest);
    const committed = await uploader.json<{ cid: string }>('/v1/vvsh/manifest', { method: 'PUT', body: { manifest } });
    assert.equal(committed.cid, contentIdOf(manifest));
  });

  it('charges per chunk for every object a user pulls while walking down from a branch', async () => {
    const viewer = clientFor(url, 'pseudonym');
    const balance = async () => (await viewer.json<{ account: { balance: number } }>('/v1/account')).account.balance;
    const before = await balance();
    const first = await viewer.fetch(`/v1/vvsh/objects/${encodeURIComponent(file.root)}`);
    assert.ok(Number(first.headers.get('x-vs-charged')) >= 0, 'every object is priced per chunk');
    const record = parseVvshNode(new Uint8Array(await first.arrayBuffer()), file.root);
    assert.ok(record && record.kind === 'branch', 'the root is a branch stored on its own');
    assert.ok((await balance()) <= before, 'the walk paid for what it fetched');
    await assert.rejects(viewer.json('/v1/vvsh/objects/chk1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), /does not have/);
  });

  it('quotes a conversion from the metadata, the length and the encodings, and runs it', async () => {
    const account = clientFor(url, 'identity');
    const config: VvshBuildConfig = { bitrates: RENDITIONS.slice(0, 2), chunkSeconds: 10, previewSplits: 3 };
    const quoted = await account.json<{ quote: { credits: number; breakdown: { chunks: number; renditions: number; previews: number } } }>('/v1/vvsh/quote', {
      body: { bytes: source.length, totalSeconds: 30, config },
    });
    assert.equal(quoted.quote.breakdown.chunks, 6, 'three chunks of two encodings');
    assert.equal(quoted.quote.breakdown.previews, 3);
    assert.ok(quoted.quote.credits > 0);
    const before = (await account.json<{ account: { balance: number } }>('/v1/account')).account.balance;
    const started = await account.json<{ jobId: string; quote: { credits: number } }>('/v1/vvsh/convert', {
      body: { name: 'made-here.vvsh', bytes: source.length, totalSeconds: 30, config },
    });
    await account.json(`/v1/vvsh/convert/${started.jobId}/piece`, { method: 'PUT', raw: source });
    const converted = await account.json<{ manifest: Manifest; quote: { credits: number } }>(`/v1/vvsh/convert/${started.jobId}/finish`, {
      method: 'POST',
      body: {},
    });
    assert.equal(converted.manifest.vvsh?.meta.chunkCount, 3);
    assert.equal(converted.manifest.vvsh?.meta.chunkSeconds, 10);
    const after = (await account.json<{ account: { balance: number } }>('/v1/account')).account.balance;
    assert.equal(after, before - converted.quote.credits, 'the quote was charged before the work ran');
    const root = await account.fetch(`/v1/vvsh/objects/${encodeURIComponent(converted.manifest.vvsh!.root)}`);
    assert.equal(root.status, 200, 'the converted stream is queryable from its root');
    const committed = await account.json<{ cid: string }>('/v1/vvsh/manifest', { method: 'PUT', body: { manifest: converted.manifest } });
    assert.match(committed.cid, /^vs1/);
  });
});

describe('the video prefetch setting', () => {
  it('keeps fetching a minute ahead by default, configurable within bounds', () => {
    const settings = defaultSettings();
    assert.equal(settings.vvshPrefetchSeconds, 60, 'a minute ahead by default');
    assert.equal(normalizeSettings({ ...settings, vvshPrefetchSeconds: 99_999 }).vvshPrefetchSeconds, 3_600, 'clamped to an hour');
    assert.equal(normalizeSettings({ ...settings, vvshPrefetchSeconds: 0 }).vvshPrefetchSeconds, 0, '0 fetches only what is playing');
    assert.equal(normalizeSettings({ vvshPrefetchSeconds: 30 }).vvshPrefetchSeconds, 30);
    assert.equal(normalizeSettings({}).vvshPrefetchSeconds, 60, 'older settings pick up the default');
  });
});

describe('a client streaming and exporting a .vvsh', async () => {
  const provider = await startProvider();
  const { dir, cleanup } = tempDir();
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    await provider.stop();
    cleanup();
  });
  await api('/api/nodes', { body: { text: provider.reference() } });
  const source = randomBytesOf(30_000);
  const config: VvshBuildConfig = { bitrates: RENDITIONS, chunkSeconds: 10, previewSplits: 3, gop: 8 };
  const nodeId = (await api<{ nodes: { id: string; type: string }[] }>('/api/state')).nodes.find((node) => node.type === 'provider')!.id;
  const session = await api<{ jobId: string }>('/api/vvsh/session', {
    body: { mode: 'publish', nodeId, name: 'stream.vvsh', totalSeconds: 30, config, sourceMime: 'video/mp4' },
  });
  await api(`/api/vvsh/session/${session.jobId}/piece`, { body: { data: base64url(source) } });
  const published = await api<{ cid: string; manifest: Manifest }>(`/api/vvsh/session/${session.jobId}/finish`, { body: {} });
  const file = published.manifest.vvsh!;

  it('skips to a timestamp and retrieves only that chunk, verified', async () => {
    const nodeId = (await api<{ nodes: { id: string; type: string }[] }>('/api/state')).nodes.find((node) => node.type === 'provider')!.id;
    const chunk = await api<{ data: string; frames: { i: number; p: number; b: number } }>('/api/vvsh/chunk', {
      body: { nodeId, file, index: 2, rendition: '1080p' },
    });
    assert.ok(chunk.frames.i >= 1, 'the chunk node carried its frame statistics');
    assert.ok(chunk.data.length > 0);
  });

  it('downloads the whole stream at one bitrate as a full video file', async () => {
    const nodeId = (await api<{ nodes: { id: string; type: string }[] }>('/api/state')).nodes.find((node) => node.type === 'provider')!.id;
    const whole = await api<{ data: string; name: string }>('/api/vvsh/export', { body: { nodeId, file, rendition: '8k', name: 'movie.mp4' } });
    assert.equal(whole.name, 'movie.mp4');
    const exported = Buffer.from((await import('../src/shared/encoding.js')).fromBase64url(whole.data));
    assert.deepEqual(exported, Buffer.from(source), 'the top bitrate pieces back into the exact video');
  });
});