import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { base32Decode, base32Encode, base64url, fromBase64url } from './encoding.js';

// DER prefixes that wrap a raw 32-byte Ed25519 seed / public key.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Public key ids look like `vk1` + base32(raw Ed25519 public key). */
export const KEY_PREFIX = 'vk1';

export interface Identity {
  id: string;
  publicKey: Buffer;
  privateKey: KeyObject;
  seed: Buffer;
}

export function identityFromSeed(seed: Buffer): Identity {
  if (seed.length !== 32) throw new Error('An identity seed is 32 bytes');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = Buffer.from(spki.subarray(spki.length - 32));
  return { id: KEY_PREFIX + base32Encode(publicKey), publicKey, privateKey, seed };
}

export function generateIdentity(): Identity {
  return identityFromSeed(randomBytes(32));
}

/**
 * A pseudonym is a separate key derived from the main seed for one label (a node id).
 * Each node sees a different, unlinkable key, yet the user can always re-derive it
 * from their one backup, so credits on every node survive a reinstall.
 */
export function derivePseudonym(seed: Buffer, label: string): Identity {
  const derived = Buffer.from(hkdfSync('sha256', seed, 'vibeshare-pseudonym-v1', label, 32));
  return identityFromSeed(derived);
}

export function isKeyId(id: string): boolean {
  if (!id.startsWith(KEY_PREFIX)) return false;
  try {
    return base32Decode(id.slice(KEY_PREFIX.length)).length === 32;
  } catch {
    return false;
  }
}

function publicKeyObject(keyId: string): KeyObject {
  if (!isKeyId(keyId)) throw new Error(`Not a key id: ${keyId}`);
  const raw = base32Decode(keyId.slice(KEY_PREFIX.length));
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function signData(identity: Identity, data: string | Uint8Array): string {
  return base64url(edSign(null, typeof data === 'string' ? Buffer.from(data) : data, identity.privateKey));
}

export function verifySignature(keyId: string, data: string | Uint8Array, signature: string): boolean {
  try {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    return edVerify(null, bytes, publicKeyObject(keyId), fromBase64url(signature));
  } catch {
    return false;
  }
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(secret: string | Buffer, data: string | Uint8Array): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function randomToken(bytes = 24): string {
  return base64url(randomBytes(bytes));
}

export function randomId(prefix = '', bytes = 9): string {
  return prefix + base32Encode(randomBytes(bytes));
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Number of leading zero bits of a hash: the proof-of-work score of an input. */
export function leadingZeroBits(hash: Buffer): number {
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

/**
 * Hashcash-style proof of work. Nodes can require one before creating an account,
 * so handing out free signup credits does not invite millions of throwaway accounts.
 */
export function solveProofOfWork(input: string, bits: number): string {
  if (bits <= 0) return '0';
  for (let nonce = 0; ; nonce++) {
    const candidate = nonce.toString(36);
    if (leadingZeroBits(sha256(`${input}:${candidate}`)) >= bits) return candidate;
  }
}

export function checkProofOfWork(input: string, nonce: string, bits: number): boolean {
  if (bits <= 0) return true;
  return typeof nonce === 'string' && nonce.length < 32 && leadingZeroBits(sha256(`${input}:${nonce}`)) >= bits;
}
