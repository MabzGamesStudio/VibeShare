import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BloomFilter, BLOOM_EXPECTED_ITEMS, contentKeys, optimalHashCount } from '../src/shared/bloom.js';

const cid = 'vs1' + 'a'.repeat(52);
const other = 'vs1' + 'b'.repeat(52);

describe('bloom filters of seen content', () => {
  it('use the optimal number of hash functions for the number of bits (10,000 items)', () => {
    assert.equal(BLOOM_EXPECTED_ITEMS, 10_000);
    assert.equal(optimalHashCount(1), 1, 'never zero hashes');
    assert.equal(optimalHashCount(10), 1);
    assert.equal(optimalHashCount(10_000), 1);
    assert.equal(optimalHashCount(100_000), 7);
    assert.equal(optimalHashCount(1_000_000), 69);
    assert.equal(optimalHashCount(100_000_000), 6_931);
    assert.equal(optimalHashCount(1_000_000_000), 69_315);
  });

  it('remember a content by its cid and each separate link, independently', () => {
    assert.deepEqual(contentKeys({ id: `${cid}~yt:abc123~ia:old`, contentId: cid, link: 'yt:abc123' }), [cid, 'yt:abc123', 'ia:old']);
    assert.deepEqual(contentKeys({ id: 'yt:music1' }), ['yt:music1'], 'external content is its own link');
    assert.deepEqual(contentKeys({ id: cid, contentId: cid }), [cid]);

    const filter = new BloomFilter(100_000);
    filter.addContent({ id: `${cid}~yt:abc123`, contentId: cid, link: 'yt:abc123' });
    assert.ok(filter.has(cid), 'the cid');
    assert.ok(filter.has('yt:abc123'), 'the link');
    assert.ok(filter.seesContent({ contentId: cid }), 'found by cid alone');
    assert.ok(filter.seesContent({ link: 'yt:abc123' }), 'found by link alone');
    assert.ok(filter.seesContent({ id: `${cid}~yt:other` }), 'the cid collides even when the links differ');
    assert.ok(!filter.seesContent({ contentId: other }), 'a different content does not collide');
  });

  it('never miss what was added, and only mistake rarely', () => {
    const filter = new BloomFilter(100_000);
    assert.equal(filter.k, 7, 'the optimal count for 100,000 bits');
    for (let i = 0; i < 200; i++) filter.addContent({ id: `yt:item${i}` });
    for (let i = 0; i < 200; i++) assert.ok(filter.seesContent({ id: `yt:item${i}` }), `item ${i} is remembered`);
    let wrong = 0;
    for (let i = 0; i < 2_000; i++) if (filter.seesContent({ id: `yt:other${i}` })) wrong++;
    assert.ok(wrong < 100, `false positives stay rare (${wrong} of 2000)`);
  });

  it('save and reload without changing a bit', () => {
    const filter = new BloomFilter(10_000);
    filter.addContent({ id: `${cid}~yt:zzz`, contentId: cid, link: 'yt:zzz' });
    const saved = filter.toJSON();
    assert.equal(saved.v, 1);
    assert.equal(saved.m, 10_000);
    assert.equal(saved.k, optimalHashCount(10_000));
    assert.equal(saved.n, BLOOM_EXPECTED_ITEMS);
    assert.equal(saved.added, 2);
    const restored = BloomFilter.from(saved);
    assert.ok(restored.seesContent({ id: cid }));
    assert.ok(restored.seesContent({ link: 'yt:zzz' }));
    assert.ok(!restored.seesContent({ id: 'yt:never' }), 'nothing else collides');
  });

  it('pick the hash count for the number of items the filter is made for', () => {
    assert.equal(optimalHashCount(100_000, 1_000), 69);
    assert.equal(optimalHashCount(100_000, 100_000), 1);
    assert.equal(optimalHashCount(100_000, 500), 139);
    const filter = new BloomFilter(100_000, 500);
    assert.equal(filter.expected, 500);
    assert.equal(filter.k, 139);
    assert.equal(filter.toJSON().n, 500, 'the capacity travels with the bits');
    const restored = BloomFilter.from(filter.toJSON());
    assert.equal(restored.expected, 500);
    assert.equal(restored.k, 139, 'a reload keeps the same hash count');
  });

  it('spend ceil(m/8) bytes on the bits, at every slider stop', () => {
    assert.equal(new BloomFilter(1).bytes, 1);
    assert.equal(new BloomFilter(10).bytes, 2);
    assert.equal(new BloomFilter(100_000).bytes, 12_500);
    assert.equal(new BloomFilter(1_000_000_000).bytes, 125_000_000);
  });

  it('refuse impossible shapes', () => {
    assert.throws(() => new BloomFilter(0), /at least one bit/);
    assert.throws(() => BloomFilter.from({ v: 1, m: 100, k: 1, data: 'AAAA' }), /does not match the size/);
  });
});
