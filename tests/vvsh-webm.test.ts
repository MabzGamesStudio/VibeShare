// The segmented side of .vvsh: WebM files cut into media segments, one per chunk, that a
// player can fetch and play on their own. The WebM fixtures here are written by hand —
// real EBML elements — so the splitter, the timecode patching and the frame counting are
// checked against bytes with known contents.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countClusterFrames, patchClusterTimecode, readClusterTimecode, splitWebm, webmCodecString } from '../src/shared/webm.js';
import { buildVvsh } from '../src/shared/vvsh-encode.js';
import { parseVvshFile, serializeVvshFile, walkToChunk } from '../src/shared/vvsh.js';

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

/** One complete WebM recording, as MediaRecorder would write it: header, tracks, clusters. */
function webmFile(clusters: { time: number; blocks: { at: number; key: boolean; payload: number[] }[] }[]): Uint8Array {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], Uint8Array.from([0x42, 0x86, 0x01, 0x01]));
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, 1234.5);
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    join(element([0x2a, 0xd7, 0xb1], uintBytes(1_000_000)), element([0x44, 0x89], duration)) // TimecodeScale 1 ms, Duration
  );
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
  return join(header, element([0x18, 0x53, 0x80, 0x67], join(info, tracks, ...clusterBytes)));
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