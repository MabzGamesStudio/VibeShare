import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildManifestFromBuffer, chunksForRange, contentIdOf, signManifest, validateManifest } from '../src/shared/content.js';
import {
  checkProofOfWork,
  derivePseudonym,
  generateIdentity,
  identityFromSeed,
  isKeyId,
  signData,
  solveProofOfWork,
  verifySignature,
} from '../src/shared/crypto.js';
import { base32Decode, base32Encode, canonicalJson } from '../src/shared/encoding.js';
import { formatNodeRef, parseNodeRef, parseNodeRefs } from '../src/shared/noderef.js';
import { baseId, embedFor, parseContentId, sourceFromUrl, withSources } from '../src/shared/sources.js';
import { prioritize } from '../src/algorithm/sources.js';
import { signS3Request } from '../src/provider/storage/s3sign.js';
import { formatUnits, unitsForCredits } from '../src/commerce/payments.js';
import { ratingAllowed } from '../src/shared/taxonomy.js';

describe('encoding', () => {
  it('round-trips base32 and sorts canonical JSON keys', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 7]);
    assert.deepEqual([...base32Decode(base32Encode(bytes))], [...bytes]);
    assert.equal(base32Encode(Buffer.from('foobar')), 'mzxw6ytboi');
    assert.equal(canonicalJson({ b: 1, a: [true, { d: null, c: 'x' }], z: undefined }), '{"a":[true,{"c":"x","d":null}],"b":1}');
  });

  it('accepts only the canonical base32 of a byte string', () => {
    assert.deepEqual([...base32Decode('mzxw6ytboi')], [...Buffer.from('foobar')]);
    assert.deepEqual([...base32Decode('MZXW6YTBOI=')], [...Buffer.from('foobar')]); // case and padding are tolerated
    for (let size = 0; size < 40; size++) {
      const bytes = Buffer.alloc(size, (size * 7) & 255);
      assert.deepEqual([...base32Decode(base32Encode(bytes))], [...bytes]);
    }
    assert.throws(() => base32Decode('mzxw6ytboj'), /padding bits/); // non-zero trailing bits
    assert.throws(() => base32Decode('mzxw6ytboi' + 'a'), /length/); // a trailing character that forms no byte
    assert.throws(() => base32Decode('m'), /length/); // too short to form a byte
    assert.throws(() => base32Decode('mzxw6ytbo1'), /character/);
  });
});

describe('identities', () => {
  it('signs and verifies; pseudonyms are stable per label and distinct across labels', () => {
    const identity = generateIdentity();
    const sig = signData(identity, 'hello');
    assert.ok(verifySignature(identity.id, 'hello', sig));
    assert.ok(!verifySignature(identity.id, 'hellO', sig));
    assert.equal(identityFromSeed(identity.seed).id, identity.id);
    const a1 = derivePseudonym(identity.seed, 'node-a');
    assert.equal(derivePseudonym(identity.seed, 'node-a').id, a1.id);
    assert.notEqual(derivePseudonym(identity.seed, 'node-b').id, a1.id);
    assert.notEqual(a1.id, identity.id);
    // Ids are canonical: only one spelling decodes to a key, so mangled trailing
    // bits cannot turn an id into another text for the same key.
    const mangled = identity.id.slice(0, -1) + (identity.id.endsWith('a') ? 'b' : 'r');
    assert.ok(isKeyId(identity.id));
    assert.ok(!isKeyId(mangled));
    assert.ok(!verifySignature(mangled, 'hello', sig));
  });

  it('solves and checks proof of work', () => {
    const nonce = solveProofOfWork('input', 10);
    assert.ok(checkProofOfWork('input', nonce, 10));
    assert.ok(!checkProofOfWork('other', nonce, 16));
  });
});

describe('content ids and sources', () => {
  const native = 'vs1' + 'a'.repeat(52);

  it('parses native ids with fallbacks and external ids', () => {
    assert.deepEqual(parseContentId(`${native}~yt:abc~ia:movie`), {
      full: `${native}~yt:abc~ia:movie`,
      base: native,
      native: true,
      sources: [
        { scheme: 'yt', value: 'abc' },
        { scheme: 'ia', value: 'movie' },
      ],
    });
    assert.equal(parseContentId('yt:abc')?.native, false);
    assert.equal(parseContentId('nope'), null);
    assert.equal(parseContentId('vs1short'), null);
    assert.equal(baseId(`${native}~yt:abc`), native);
    assert.equal(withSources(native, [{ scheme: 'yt', value: 'abc' }, { scheme: 'yt', value: 'abc' }]), `${native}~yt:abc`);
  });

  it('turns links into sources and sources into embeds', () => {
    const cases: [string, string][] = [
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'yt:dQw4w9WgXcQ'],
      ['https://youtu.be/dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
      ['https://www.youtube.com/shorts/abcdEFGhijk', 'yt:abcdEFGhijk'],
      ['https://vimeo.com/76979871', 'vimeo:76979871'],
      ['https://soundcloud.com/artist/track', 'sc:artist/track'],
      ['https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'],
      ['https://www.tiktok.com/@user/video/7234567890', 'tiktok:7234567890'],
      ['https://x.com/someone/status/1234', 'x:1234'],
      ['https://www.twitch.tv/videos/987', 'twitch:v987'],
      ['https://archive.org/details/BigBuckBunny_124', 'ia:BigBuckBunny_124'],
      ['https://framatube.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d', 'peertube:framatube.org/9c9de5e8-0a1e-484a-b099-e80766180a6d'],
      ['https://example.com/w/about', 'url:https%3A%2F%2Fexample.com%2Fw%2Fabout'],
      ['https://tube.example/videos/watch/abc-123', 'peertube:tube.example/abc-123'],
      ['ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/movie.mp4', 'ipfs:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/movie.mp4'],
    ];
    for (const [url, expected] of cases) {
      const source = sourceFromUrl(url)!;
      assert.equal(`${source.scheme}:${source.value}`, expected, url);
    }
    assert.equal(embedFor({ scheme: 'yt', value: 'x1' }).src, 'https://www.youtube-nocookie.com/embed/x1');
    assert.equal(embedFor({ scheme: 'ipfs', value: 'bafy/movie.mp4' }, { ipfsGateway: 'https://gw.example' }).kind, 'video');
    assert.equal(embedFor({ scheme: 'url', value: encodeURIComponent('https://a.example/song.mp3') }).kind, 'audio');
    assert.equal(embedFor({ scheme: 'url', value: encodeURIComponent('javascript:alert(1)') }).kind, 'link');
  });

  it('hashes manifests, signs creators and refuses tampering', async () => {
    const creator = generateIdentity();
    const data = Buffer.alloc(3000, 7);
    const manifest = signManifest(await buildManifestFromBuffer(data, { name: 'a.bin', mime: 'application/octet-stream', chunkSize: 1024 }), creator, {
      name: 'Ada',
      kind: 'person',
    });
    assert.equal(manifest.chunks.length, 3);
    assert.ok(validateManifest(manifest));
    assert.match(contentIdOf(manifest), /^vs1[a-z2-7]{52}$/);
    assert.throws(() => validateManifest({ ...manifest, name: 'b.bin' }), /signature/);
    assert.throws(() => validateManifest({ ...manifest, size: 2999 }), /add up/);
    const { creator: _c, ...unsigned } = manifest;
    assert.notEqual(contentIdOf(unsigned as typeof manifest), contentIdOf(manifest));
    assert.deepEqual(chunksForRange(manifest, 1000, 2100), { first: 0, last: 2, offset: 1000 });
  });
});

describe('source priorities', () => {
  it('always put content of a higher-priority source first', () => {
    const items = [{ id: 'ia:old' }, { id: 'yt:new' }, { id: 'vimeo:mid' }, { id: 'yt:second' }];
    assert.deepEqual(
      prioritize(items, { youtube: 10, vimeo: 5, archive: 1 }).map((item) => item.id),
      ['yt:new', 'yt:second', 'vimeo:mid', 'ia:old'],
      'the higher the priority of the platform, the earlier its content'
    );
    assert.deepEqual(prioritize(items, {}).map((item) => item.id), ['ia:old', 'yt:new', 'vimeo:mid', 'yt:second'], 'the same priority keeps the ranking');
    assert.deepEqual(prioritize(items, { archive: 0 }).map((item) => item.id), ['yt:new', 'vimeo:mid', 'yt:second'], 'priority 0 hides a source');
  });
});

describe('node references', () => {
  const id = 'vk1' + 'b'.repeat(52);
  it('formats, parses and accepts bare URLs', () => {
    const ref = formatNodeRef({ type: 'provider', id, url: 'https://cdn.example.org' });
    assert.equal(ref, `vs:provider:${id}@https://cdn.example.org`);
    assert.deepEqual(parseNodeRef(ref), { type: 'provider', id, url: 'https://cdn.example.org' });
    assert.deepEqual(parseNodeRef('http://10.0.0.5:7702/'), { url: 'http://10.0.0.5:7702' });
    assert.equal(parseNodeRef('ftp://x'), null);
    assert.equal(parseNodeRef('https://user:pass@example.org'), null);
    const many = parseNodeRefs(`${ref}\n  https://b.example, junk`);
    assert.equal(many.refs.length, 2);
    assert.deepEqual(many.invalid, ['junk']);
  });
});

describe('S3 request signing', () => {
  it('matches the AWS Signature Version 4 example (GET Object)', () => {
    const headers = signS3Request({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      headers: { range: 'bytes=0-9' },
      date: new Date('2013-05-24T00:00:00Z'),
    });
    assert.match(headers.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  });
});

describe('payment amounts and ratings', () => {
  it('converts credits to exact smallest units', () => {
    assert.equal(unitsForCredits(1000, 1000, 6), 1_000_000n);
    assert.equal(unitsForCredits(1, 3, 18), 333333333333333334n);
    assert.equal(formatUnits(1_500_000n, 6), '1.5');
    assert.equal(formatUnits(100_000_123n, 8), '1.00000123');
  });

  it('orders age ratings', () => {
    assert.ok(ratingAllowed('13+', '16+'));
    assert.ok(!ratingAllowed('18+', '16+'));
    assert.ok(!ratingAllowed('nsfw', '18+'));
    assert.ok(ratingAllowed(undefined, 'all'));
  });
});
