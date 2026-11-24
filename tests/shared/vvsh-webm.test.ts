// The segmented side of .vvsh: WebM files cut into media segments, one per chunk, that a
// player can fetch and play on their own. The WebM fixtures here are written by hand —
// real EBML elements — so the splitter, the timecode patching and the frame counting are
// checked against bytes with known contents.
import assert from 'node:assert/strict';
import { join as joinPath } from 'node:path';
import { after, describe, it } from 'node:test';
import { countClusterFrames, patchClusterTimecode, readClusterTimecode, readWebmElement, splitWebm, webmClusters, webmCodecString } from '../../src/shared/webm.js';
import { assembleVvshWebm, buildVvsh, normalizeVvshWebmChunk } from '../../src/shared/vvsh-encode.js';
import { parseVvshFile, pathToChunk, serializeVvshFile, walkToChunk } from '../../src/shared/vvsh.js';
import { base64url } from '../../src/shared/encoding.js';
import type { Manifest } from '../../src/shared/content.js';
import { startClient, startProvider, tempDir } from '../helpers.js';

/** EBML size field: as many bytes as the size needs, marker bit kept. */
function sizeVint(size: number): Uint8Array {
  let width = 1;
  while (size >= 2 ** (7 * width) - 1) width++;
  const out = new Uint8Array(width);
  let value = size;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = value % 256;
    value = Math.floor(value / 256);
  }
  out[0] |= 0x80 >> (width - 1);
  return out;
}

function uintBytes(value: number, width = 4): Uint8Array {
  const out = new Uint8Array(width);
  let rest = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

function element(id: number[], payload: Uint8Array): Uint8Array {
  return Uint8Array.from([...id, ...sizeVint(payload.length), ...payload]);
}

function join(...pieces: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

/** A SimpleBlock holding one frame of `payload` bytes (track 1, relative timecode, flags). */
function simpleBlock(relativeTime: number, keyframe: boolean, payload: number[]): Uint8Array {
  return element([0xa3], Uint8Array.from([0x81, (relativeTime >> 8) & 0xff, relativeTime & 0xff, keyframe ? 0x80 : 0x00, ...payload]));
}

/** One complete WebM recording, as MediaRecorder would write it: header, tracks, clusters.
 *  `pad` leaves zero bytes between the clusters (fragment alignment); `duration: false`
 *  omits the Duration element (real recordings are live and carry none); `scale` sets
 *  the TimestampScale the cluster timecodes are expressed in. */
function webmFile(
  clusters: { time: number; blocks: { at: number; key: boolean; payload: number[] }[] }[],
  opts: { pad?: boolean; scale?: number; duration?: boolean } = {}
): Uint8Array {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], Uint8Array.from([0x42, 0x86, 0x01, 0x01]));
  const infoParts = [element([0x2a, 0xd7, 0xb1], uintBytes(opts.scale ?? 1_000_000))]; // TimecodeScale
  if (opts.duration !== false) {
    const duration = new Uint8Array(8);
    new DataView(duration.buffer).setFloat64(0, 1234.5);
    infoParts.push(element([0x44, 0x89], duration)); // Duration
  }
  const info = element([0x15, 0x49, 0xa9, 0x66], join(...infoParts));
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    join(
      element([0xae], join(element([0x83], Uint8Array.from([0x01])), element([0x86], new TextEncoder().encode('V_VP8')))),
      element([0xae], join(element([0x83], Uint8Array.from([0x02])), element([0x86], new TextEncoder().encode('A_OPUS'))))
    )
  );
  const clusterBytes = clusters.map((cluster) =>
    element(
      [0x1f, 0x43, 0xb6, 0x75],
      join(element([0xe7], uintBytes(cluster.time)), ...cluster.blocks.map((block) => simpleBlock(block.at, block.key, block.payload)))
    )
  );
  const padded = clusterBytes.flatMap((cluster, at) => (at && opts.pad ? [Uint8Array.from([0, 0, 0]), cluster] : [cluster]));
  return join(header, element([0x18, 0x53, 0x80, 0x67], join(info, tracks, ...padded)));
}

/** The Duration element of a file (Matroska float64, in timecode units). */
function durationOf(bytes: Uint8Array): number {
  let at = 0;
  while (at < bytes.length) {
    const element = readWebmElement(bytes, at);
    if (!element || element.total <= 0) {
      at++; // zero padding
      continue;
    }
    if (element.id === 0x4489) return new DataView(bytes.buffer, bytes.byteOffset + element.at, element.size).getFloat64(0);
    const inner = durationOf(bytes.subarray(element.at, element.at + element.size));
    if (inner > 0) return inner;
    at += element.total;
  }
  return 0;
}

describe('segmented .vvsh streams (WebM media segments)', () => {
  it('splits a WebM file into its init part and its clusters', () => {
    const file = webmFile([
      { time: 0, blocks: [{ at: 0, key: true, payload: [1, 2, 3] }, { at: 40, key: false, payload: [4] }] },
      { time: 80, blocks: [{ at: 0, key: false, payload: [5, 6] }] },
    ]);
    const { init, clusters, timecodeScale } = splitWebm(file);
    assert.equal(clusters.length, 2, 'both clusters come out on their own');
    assert.equal(timecodeScale, 1_000_000, 'the timecode scale is read from the file');
    assert.equal(webmCodecString(init), 'vp8,opus', 'the codec string is what MediaSource wants');
    const again = splitWebm(join(init, ...clusters));
    assert.equal(again.init.length, init.length, 'init + clusters is a valid WebM again');
    assert.equal(again.clusters.length, 2);
  });

  it('moves clusters onto the stream timeline and counts their frames', () => {
    const file = webmFile([
      { time: 0, blocks: [{ at: 0, key: true, payload: [1] }, { at: 40, key: false, payload: [2] }, { at: 80, key: false, payload: [3] }] },
    ]);
    const { clusters } = splitWebm(file);
    const cluster = Uint8Array.from(clusters[0]);
    assert.equal(readClusterTimecode(cluster), 0);
    patchClusterTimecode(cluster, 20_000);
    assert.equal(readClusterTimecode(cluster), 20_000, 'the cluster moves to its place in the stream');
    assert.deepEqual(countClusterFrames(cluster), { key: 1, delta: 2 }, 'one keyframe, two delta frames');
  });

  it('builds a stream whose chunks play alone, and round-trips its file', async () => {
    // Two encodings, three chunks each: the smaller encoding holds fewer bytes per chunk.
    const chunksOf = (weights: number[]) =>
      weights.map((weight, index) =>
        webmFile([{ time: 0, blocks: [{ at: 0, key: true, payload: Array.from({ length: weight }, (_, i) => (index * 7 + i) % 251) }] }])
      );
    const objects = new Map<string, Uint8Array>();
    const { file } = await buildVvsh(
      new Uint8Array(0),
      {
        totalSeconds: 3,
        config: {
          chunkSeconds: 1,
          previewSplits: 2,
          bitrates: [{ id: '720p', label: '720p', kbps: 2000 }, { id: '360p', label: '360p', kbps: 500 }],
        },
        previewWidth: 240,
        previewQuality: 0.6,
        webm: { '720p': chunksOf([400, 420, 380]), '360p': chunksOf([90, 85, 95]) },
      },
      (hash, data) => {
        objects.set(hash, data);
      }
    );
    assert.equal(file.meta.codec, 'vvsh-webm/1', 'the file says it is made of WebM segments');
    assert.equal(file.meta.codecs, 'vp8,opus', 'and names the codecs a player needs');
    assert.equal(file.meta.chunkCount, 3);
    for (const rendition of file.meta.bitrates) {
      assert.ok(rendition.initHash, `${rendition.id} names its init part`);
      assert.ok(rendition.bytes && rendition.bytes > 0, `${rendition.id} knows its size`);
    }
    const small = file.meta.bitrates.find((entry) => entry.id === '360p');
    const large = file.meta.bitrates.find((entry) => entry.id === '720p');
    assert.ok(small?.bytes && large?.bytes && small.bytes < large.bytes, 'the smaller encoding really stores fewer bytes');

    // The publisher's preview capture settings travel in the metadata and round-trip.
    assert.deepEqual(
      { width: file.meta.previews?.width, quality: file.meta.previews?.quality, count: file.meta.previews?.images.length },
      { width: 240, quality: 0.6, count: 2 },
      'the metadata says how the scrubbing previews were captured'
    );

    // The packed file round-trips with the init hashes and codec string intact.
    const packed = parseVvshFile(serializeVvshFile(file));
    assert.equal(packed.meta.codecs, 'vp8,opus');
    assert.equal(packed.meta.previews?.width, 240, 'the capture width survives the packed form');
    assert.equal(packed.meta.previews?.quality, 0.6, 'so does the JPEG quality');
    assert.equal(packed.meta.bitrates.find((entry) => entry.id === '720p')?.initHash, large?.initHash);
    assert.equal(packed.root, file.root, 'the root survives the packed form');

    // Walking down the tree finds each chunk's segments — the pieces a sparse player fetches.
    for (let index = 0; index < 3; index++) {
      const node = await walkToChunk(file.root, 3, index, async (hash) => objects.get(hash) ?? null);
      assert.ok(node, `chunk ${index} is reachable from the root`);
      assert.equal(node.index, index);
      assert.equal(node.renditions.length, 2, 'each chunk carries both encodings');
    }
  });

  it('keeps every cluster of a zero-padded recording and puts the chunks on one timeline', async () => {
    // What the no-FFmpeg browser fallback records: every chunk is its own WebM whose
    // clusters run from zero, with fragment padding between them. Everything after the
    // first gap of padding used to be dropped silently — the video then played about a
    // second (one cluster) and stopped at the hole left in its timeline.
    const recording = () =>
      webmFile(
        [0, 1000, 2000, 3000, 4000].map((time) => ({ time, blocks: [{ at: 0, key: true, payload: [1] }, { at: 500, key: false, payload: [2] }] })),
        { pad: true }
      );
    const objects = new Map<string, Uint8Array>();
    const { file } = await buildVvsh(
      new Uint8Array(0),
      {
        totalSeconds: 15,
        config: { bitrates: [{ id: 'r', label: 'r', height: 360, kbps: 500 }], chunkSeconds: 5, previewSplits: 0 },
        webm: { r: [recording(), recording(), recording()] },
      },
      (hash, data) => {
        objects.set(hash, data);
      }
    );
    assert.equal(file.meta.chunkCount, 3);
    const timeline: number[] = [];
    for (let index = 0; index < 3; index++) {
      const node = await walkToChunk(file.root, 3, index, async (hash) => objects.get(hash) ?? null);
      const payload = objects.get(node!.renditions[0].hash)!;
      const times = webmClusters(payload).map((cluster) => readClusterTimecode(cluster));
      assert.equal(times.length, 5, `chunk ${index} keeps every cluster of its recording`);
      assert.deepEqual(times, [0, 1000, 2000, 3000, 4000].map((time) => index * 5000 + time), `chunk ${index} sits in its own time slot`);
      // What the player appends for this chunk keeps the same order.
      const appended = webmClusters(normalizeVvshWebmChunk(payload, index, 5)).map((cluster) => readClusterTimecode(cluster));
      assert.deepEqual(appended, times, 'the media segment the player appends keeps the order');
      timeline.push(...times);
    }
    assert.deepEqual([...timeline].sort((a, b) => a - b), timeline, 'the stream timeline only moves forward');
    // The init segment carries the recordings' tracks and the length of the whole stream.
    const init = objects.get(file.meta.bitrates[0].initHash!)!;
    assert.equal(webmCodecString(init), 'vp8,opus', 'the init part names the recordings’ codecs');
    assert.ok(Math.abs(durationOf(init) - 15_000) < 1, 'and the duration of the whole stream');
  });

  it('fits each recording into its own time slot, so nothing regresses at a chunk border', async () => {
    // A real recording runs long on its own clock: the player ramps up before its content
    // and the recorder stops a poll late. Fitted at their own coordinates the chunks
    // overlapped at every border — the appended timeline stepped backwards and playback
    // stopped at the first chunk border while the provider's stored chunks were complete.
    const recording = () =>
      webmFile(
        [0, 1000, 2000, 3000, 4000, 5000, 5300].map((time) => ({
          time,
          blocks: [{ at: 0, key: true, payload: [1] }, { at: 500, key: false, payload: [2] }],
        })),
        { pad: true, duration: false }
      );
    const objects = new Map<string, Uint8Array>();
    const { file } = await buildVvsh(
      new Uint8Array(0),
      {
        totalSeconds: 15,
        config: { bitrates: [{ id: 'r', label: 'r', height: 360, kbps: 500 }], chunkSeconds: 5, previewSplits: 0 },
        webm: { r: [recording(), recording(), recording()] },
      },
      (hash, data) => {
        objects.set(hash, data);
      }
    );
    const timeline: number[] = [];
    for (let index = 0; index < 3; index++) {
      const node = await walkToChunk(file.root, 3, index, async (hash) => objects.get(hash) ?? null);
      const payload = objects.get(node!.renditions[0].hash)!;
      // What the player appends after the first chunk is a media segment: clusters only.
      // A second EBML or Segment header in it is the other way playback stops at a border.
      const text = Buffer.from(payload).toString('latin1');
      assert.ok(!text.includes('\x1aE\xdf\xa3'), `chunk ${index} carries no EBML header`);
      assert.ok(!text.includes('\x18S\x80g'), `chunk ${index} carries no Segment header`);
      const times = webmClusters(payload).map((cluster) => readClusterTimecode(cluster));
      assert.equal(times.length, 7, `chunk ${index} keeps every cluster of its recording`);
      assert.deepEqual(times, [...times].sort((a, b) => a - b), `chunk ${index} is in order`);
      assert.ok(times[0] >= index * 5000, `chunk ${index} does not start before its slot`);
      assert.ok(times[times.length - 1] < (index + 1) * 5000, `chunk ${index} does not reach into the next slot`);
      timeline.push(...times);
    }
    assert.deepEqual([...timeline].sort((a, b) => a - b), timeline, 'the stream timeline only moves forward across chunk borders');
  });

  it('recovers global timestamps wrapped by the old narrow-field patcher', () => {
    const legacyCluster = (timecode: number, width: number) =>
      element(
        [0x1f, 0x43, 0xb6, 0x75],
        join(element([0xe7], uintBytes(timecode, width)), simpleBlock(0, true, [1, 2, 3]))
      );
    // 3000 used to fit into one byte as 184; the following two-byte Cluster was intact.
    const legacy = join(legacyCluster(184, 1), legacyCluster(5920, 2));
    const repaired = normalizeVvshWebmChunk(legacy, 1, 3);
    assert.deepEqual(webmClusters(repaired).map(readClusterTimecode), [3000, 5920]);
  });

  it('refuses a chunk count that does not match the stream', async () => {
    await assert.rejects(
      buildVvsh(new Uint8Array(0), {
        totalSeconds: 4,
        config: { chunkSeconds: 1, previewSplits: 0, bitrates: [{ id: '360p', label: '360p', kbps: 500 }] },
        webm: { '360p': [webmFile([{ time: 0, blocks: [{ at: 0, key: true, payload: [1] }] }])] },
      }),
      /expected 4/,
      'every encoding must cover every chunk'
    );
  });
});
describe('a MediaRecorder .vvsh through storage and playback', async () => {
  const provider = await startProvider();
  const { dir, cleanup } = tempDir();
  const { client, api } = await startClient(joinPath(dir, 'client'));
  after(async () => {
    await client.stop();
    await provider.stop();
    cleanup();
  });
  await api('/api/nodes', { body: { text: provider.reference() } });

  it('plays every chunk of recordings at any timecode scale', async () => {
    const nodeId = (await api<{ nodes: { id: string; type: string }[] }>('/api/state')).nodes.find((node) => node.type === 'provider')!.id;
    // The browser fallback records one WebM per chunk: its clusters run from zero in the
    // recorder's own timecode units, live recordings carry no Duration, and fragment
    // padding sits between the clusters. The stream must come out whole at any
    // TimestampScale — the pieces used to be re-based as if every file spoke
    // milliseconds, which parked later chunks far beyond the end of the video, and the
    // video played until the hole and stopped there.
    for (const scale of [1_000_000, 10_000_000, 100_000]) {
      const recording = () =>
        webmFile(
          [0, 1000, 2000, 3000, 4000].map((time) => ({
            time: Math.round((time * 1e6) / scale), // milliseconds into the file's timecode units
            blocks: [{ at: 0, key: true, payload: [1] }, { at: 500, key: false, payload: [2] }],
          })),
          { pad: true, duration: false, scale }
        );
      const objects: { hash: string; data: Uint8Array }[] = [];
      const { file } = await buildVvsh(
        new Uint8Array(0),
        {
          totalSeconds: 15,
          config: { bitrates: [{ id: 'r', label: 'r', height: 360, kbps: 500 }], chunkSeconds: 5, previewSplits: 0 },
          webm: { r: [recording(), recording(), recording()] },
        },
        (hash, data) => {
          objects.push({ hash, data });
        }
      );
      assert.equal(file.meta.chunkCount, 3, `scale ${scale}: the recordings make three chunks`);
      // The browser's own upload calls: every object, then the commit.
      for (const object of objects) {
        await api('/api/vvsh/object', { method: 'PUT', body: { nodeId, hash: object.hash, data: base64url(object.data) } });
      }
      const manifest: Manifest = { v: 1, name: 'v.vvsh', mime: 'video/x-vvsh', size: 0, chunkSize: 1024, chunks: [], createdAt: new Date().toISOString(), vvsh: file };
      await api('/api/vvsh/manifest', { body: { nodeId, manifest, algorithms: [], sign: false } });

      // The player's exact request sequence — including the merkle path it reuses from
      // the previous chunk — and the media segments it would append.
      const walked = new Map<string, { index: number; path: string[]; base: number }>();
      const timeline: number[] = [];
      const payloads: Uint8Array[] = [];
      for (let index = 0; index < file.meta.chunkCount; index++) {
        const previous = walked.get(file.root);
        let from: { hash: string; depth: number } | undefined;
        if (previous) {
          const before = pathToChunk(file.meta.chunkCount, previous.index);
          const want = pathToChunk(file.meta.chunkCount, index);
          let shared = 0;
          while (shared < before.length && shared < want.length && before[shared] === want[shared]) shared++;
          const deepest = Math.min(shared, previous.base + previous.path.length - 2);
          if (deepest > 0 && deepest >= previous.base) from = { hash: previous.path[deepest - previous.base], depth: deepest };
        }
        const answer = await api<{ data: string; path: string[]; pathDepth: number }>('/api/vvsh/chunk', {
          body: { nodeId, root: file.root, chunkCount: file.meta.chunkCount, index, rendition: 'r', ...(from ? { from } : {}) },
        });
        walked.set(file.root, { index, path: answer.path, base: answer.pathDepth ?? 0 });
        const segment = normalizeVvshWebmChunk(new Uint8Array(Buffer.from(answer.data, 'base64url')), index, file.meta.chunkSeconds);
        payloads.push(segment);
        const times = webmClusters(segment).map((cluster) => readClusterTimecode(cluster));
        assert.equal(times.length, 5, `scale ${scale}: chunk ${index} keeps every cluster of its recording`);
        // Times come back in the stream's own units (the init's TimestampScale).
        assert.deepEqual(
          times.map((time) => Math.round((time * scale) / 1e6)),
          [0, 1000, 2000, 3000, 4000].map((time) => index * 5000 + time),
          `scale ${scale}: chunk ${index} sits in its own time slot`
        );
        timeline.push(...times);
      }
      assert.deepEqual([...timeline].sort((a, b) => a - b), timeline, `scale ${scale}: the stream timeline only moves forward`);

      // The whole stream assembles with the recordings' tracks and the source length.
      const init = await api<{ data: string }>('/api/vvsh/object', { method: 'POST', body: { nodeId, hash: file.meta.bitrates[0].initHash! } }).then(
        (answer) => new Uint8Array(Buffer.from(answer.data, 'base64url'))
      );
      assert.equal(webmCodecString(init), 'vp8,opus', `scale ${scale}: the init part names the recordings' codecs`);
      assert.ok(durationOf(init) > 0, `scale ${scale}: the init carries the whole length although the recordings had none`);
      const whole = splitWebm(assembleVvshWebm(init, payloads, { chunkSeconds: 5, durationSeconds: 15 }));
      const wholeTimes = whole.clusters.map((cluster) => readClusterTimecode(cluster));
      assert.deepEqual([...wholeTimes].sort((a, b) => a - b), wholeTimes, `scale ${scale}: the assembled file only moves forward`);
      assert.ok(Math.abs(Math.round((durationOf(whole.init) * scale) / 1e6) - 15_000) < 10, `scale ${scale}: and its duration is the source's`);
    }
  });
});
