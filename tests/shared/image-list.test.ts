// The image-list container: many images in one file, one content, one cid.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isImageList, packImageList, parseImageList } from '../../src/shared/image-list.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8]);

describe('the image-list container', () => {
  it('round-trips its images in order', () => {
    const packed = packImageList([
      { name: 'first.png', mime: 'image/png', data: png },
      { name: 'second.jpg', mime: 'image/jpeg', data: jpg },
      { name: 'empty.png', mime: 'image/png', data: new Uint8Array(0) },
    ]);
    assert.ok(isImageList(packed), 'the magic sniffs true');
    const images = parseImageList(packed);
    assert.ok(images);
    assert.deepEqual(
      images.map((image) => [image.name, image.mime, image.data.length]),
      [
        ['first.png', 'image/png', png.length],
        ['second.jpg', 'image/jpeg', jpg.length],
        ['empty.png', 'image/png', 0],
      ]
    );
    assert.deepEqual([...images[0].data], [...png]);
    assert.deepEqual([...images[1].data], [...jpg]);
    assert.equal(images[2].data.length, 0);
  });

  it('reads back a single-image list and one packed again', () => {
    const packed = packImageList([{ name: 'one.png', mime: 'image/png', data: png }]);
    const again = packImageList(parseImageList(packed)!);
    assert.deepEqual([...again], [...packed], 'packing is deterministic');
  });

  it('gives null for anything malformed instead of throwing', () => {
    assert.equal(parseImageList(new Uint8Array(0)), null);
    assert.equal(isImageList(new Uint8Array(0)), false);
    // Not the magic at all.
    assert.equal(parseImageList(new TextEncoder().encode('<svg>the old carrier</svg>')), null);
    // Right magic, no header.
    assert.equal(parseImageList(new TextEncoder().encode('VSLIST1\n')), null);
    const packed = packImageList([{ name: 'one.png', mime: 'image/png', data: png }]);
    // Truncated inside the data block.
    assert.equal(parseImageList(packed.slice(0, packed.length - 2)), null);
    // A lying header length that cuts the index short.
    const broken = new Uint8Array(packed);
    new DataView(broken.buffer, broken.byteOffset, broken.byteLength).setUint32(8, 2);
    assert.equal(parseImageList(broken), null);
    // Garbage in place of the JSON index.
    const garbage = new Uint8Array(packed);
    garbage.set(new TextEncoder().encode('{{{'), 12);
    assert.equal(parseImageList(garbage), null);
  });
});
