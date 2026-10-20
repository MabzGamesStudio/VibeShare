// The browser implementation of src/shared/crypto.ts: the web build swaps it in (see
// vite.web.config.ts). Same exports, same bytes: keys, signatures and hashes made here
// verify on the Node side and the other way round (tests/webcrypto.test.ts).
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { base32Decode, base32Encode, base64url, fromBase64url } from '../../../src/shared/encoding.js';

export const KEY_PREFIX = 'vk1';

export interface Identity {
  id: string;
  publicKey: Uint8Array;
  /** The Ed25519 secret key (its 32-byte seed). */
  privateKey: Uint8Array;
  seed: Uint8Array;
}

const encoder = new TextEncoder();

function bytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

function random(count: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(count));
}

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error('An identity seed is 32 bytes');
  const secret = new Uint8Array(seed);
  const publicKey = new Uint8Array(ed25519.getPublicKey(secret));
  return { id: KEY_PREFIX + base32Encode(publicKey), publicKey, privateKey: secret, seed: new Uint8Array(secret) };
}

export function generateIdentity(): Identity {
  return identityFromSeed(random(32));
}

/** See src/shared/crypto.ts: one unlinkable key per node, derived from the main seed. */
export function derivePseudonym(seed: Uint8Array, label: string): Identity {
  return identityFromSeed(new Uint8Array(hkdf(nobleSha256, new Uint8Array(seed), bytes('vibeshare-pseudonym-v1'), bytes(label), 32)));
}

export function isKeyId(id: string): boolean {
  if (!id.startsWith(KEY_PREFIX)) return false;
  try {
    return base32Decode(id.slice(KEY_PREFIX.length)).length === 32;
  } catch {
    return false;
  }
}

export function signData(identity: Identity, data: string | Uint8Array): string {
  return base64url(ed25519.sign(bytes(data), new Uint8Array(identity.seed)));
}

export function verifySignature(keyId: string, data: string | Uint8Array, signature: string): boolean {
  try {
    if (!isKeyId(keyId)) return false;
    const publicKey = new Uint8Array(base32Decode(keyId.slice(KEY_PREFIX.length)));
    // Strict RFC 8032 checks, like Node's verifier.
    return ed25519.verify(new Uint8Array(fromBase64url(signature)), bytes(data), publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export function sha256(data: string | Uint8Array): Buffer {
  return Buffer.from(nobleSha256(bytes(data)));
}

function hex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sha256hex(data: string | Uint8Array): string {
  return hex(nobleSha256(bytes(data)));
}

export function hmacHex(secret: string | Buffer, data: string | Uint8Array): string {
  return hex(hmac(nobleSha256, bytes(secret), bytes(data)));
}

export function randomToken(count = 24): string {
  return base64url(random(count));
}

export function randomHex(count = 12): string {
  return hex(random(count));
}

export function randomId(prefix = '', count = 9): string {
  return prefix + base32Encode(random(count));
}

export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function solveProofOfWork(input: string, bits: number): string {
  if (bits <= 0) return '0';
  for (let nonce = 0; ; nonce++) {
    const candidate = nonce.toString(36);
    if (leadingZeroBits(nobleSha256(bytes(`${input}:${candidate}`))) >= bits) return candidate;
  }
}

export function checkProofOfWork(input: string, nonce: string, bits: number): boolean {
  if (bits <= 0) return true;
  return typeof nonce === 'string' && nonce.length < 32 && leadingZeroBits(nobleSha256(bytes(`${input}:${nonce}`))) >= bits;
}
