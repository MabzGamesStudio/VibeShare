// The web client's crypto (noble, in the browser) against the Node implementation:
// keys, pseudonyms, signatures, hashes and proofs of work must be interchangeable.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as native from '../src/shared/crypto.js';

type CryptoModule = typeof native;
const web = (await import(pathToFileURL(resolve(import.meta.dirname, '../gui/src/web/crypto.ts')).href)) as CryptoModule;

describe('web crypto', () => {
  it('has the same exports as the Node module', () => {
    assert.deepEqual(Object.keys(web).sort(), Object.keys(native).sort());
  });

  it('derives the same identities and pseudonyms', () => {
    for (let i = 0; i < 5; i++) {
      const seed = randomBytes(32);
      assert.equal(web.identityFromSeed(seed).id, native.identityFromSeed(seed).id);
      assert.ok(
        [...web.identityFromSeed(seed).publicKey].every((byte, at) => byte === native.identityFromSeed(seed).publicKey[at]),
        'the same public key bytes'
      );
      assert.equal(web.derivePseudonym(seed, `node-${i}`).id, native.derivePseudonym(seed, `node-${i}`).id);
    }
    assert.equal(web.isKeyId(native.generateIdentity().id), true);
    assert.equal(web.isKeyId('vk1short'), false);
  });

  it('signs and verifies interchangeably', () => {
    const seed = randomBytes(32);
    const browser = web.identityFromSeed(seed);
    const node = native.identityFromSeed(seed);
    for (const message of ['vibeshare-session\nvk1node\n1700000000000', new Uint8Array([0, 1, 2, 255])]) {
      const fromWeb = web.signData(browser, message);
      const fromNode = native.signData(node, message);
      assert.equal(fromWeb, fromNode, 'Ed25519 signatures are deterministic');
      assert.equal(native.verifySignature(browser.id, message, fromWeb), true);
      assert.equal(web.verifySignature(node.id, message, fromNode), true);
    }
    const other = native.generateIdentity();
    assert.equal(web.verifySignature(other.id, 'hello', web.signData(browser, 'hello')), false);
    assert.equal(web.verifySignature(browser.id, 'hello', 'not-a-signature'), false);
  });

  it('hashes, authenticates and proves work the same way', () => {
    const data = randomBytes(3000);
    assert.ok(Buffer.from(web.sha256(data)).equals(native.sha256(data)));
    assert.equal(web.sha256hex('abc'), native.sha256hex('abc'));
    assert.equal(web.hmacHex('secret', data), native.hmacHex('secret', data));
    const nonce = web.solveProofOfWork('input', 10);
    assert.equal(native.checkProofOfWork('input', nonce, 10), true);
    assert.equal(web.checkProofOfWork('input', native.solveProofOfWork('input', 10), 10), true);
    assert.equal(web.safeEqual('same', 'same'), true);
    assert.equal(web.safeEqual('same', 'diff'), false);
    assert.match(web.randomHex(12), /^[0-9a-f]{24}$/);
    assert.match(web.randomId('f', 10), /^f[a-z2-7]{16}$/);
  });
});
