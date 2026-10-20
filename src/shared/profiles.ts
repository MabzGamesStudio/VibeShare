// Client profiles: several people (or personas) sharing one client, each with their own
// nodes, settings, history and client id. A profile is public (anyone using the client
// may switch to it) or locked with a username and a password.
// Browser-safe: no Node imports (globalThis.crypto exists in Node and browsers).
import { base32Decode, base32Encode } from './encoding.js';

export interface ProfileAccessPublic {
  mode: 'public';
}

export interface ProfileAccessPassword {
  mode: 'password';
  username: string;
  /** Hex salt of the password hash. */
  salt: string;
  /** Iterated SHA-256 of `salt:username:password` (PROFILE_HASH_ROUNDS rounds). */
  hash: string;
  /** Hex salt of the encryption key of a hidden profile's sealed data. */
  keySalt?: string;
}

export type ProfileAccess = ProfileAccessPublic | ProfileAccessPassword;

export const PROFILE_HASH_ROUNDS = 10_000;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomProfileSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function fromHex(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(text.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Sealed (encrypted) profile data: hidden profiles keep everything — their name,
// their client id, their nodes, settings and history — in one AES-GCM blob that
// only opens with the profile's password.

/** A WebCrypto AES-GCM key (typed from the platform's own subtle crypto). */
export type SealKey = Awaited<ReturnType<(typeof globalThis)['crypto']['subtle']['deriveKey']>>;

export interface SealedBlob {
  v: 1;
  /** Hex initialisation vector of AES-GCM. */
  iv: string;
  /** Hex ciphertext. */
  data: string;
}

/** The encryption key of a hidden profile, derived from its password (PBKDF2). */
export function profileSealKey(password: string, keySalt: string): Promise<SealKey> {
  return globalThis.crypto.subtle
    .importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
    .then((material) =>
      globalThis.crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: fromHex(keySalt), iterations: 100_000, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      )
    );
}

export async function sealProfile(payload: unknown, key: SealKey): Promise<SealedBlob> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { v: 1, iv: toHex(iv), data: toHex(new Uint8Array(data)) };
}

/** Opens a sealed profile. Throws when the password (and so the key) is wrong. */
export async function unsealProfile<T>(blob: SealedBlob, key: SealKey): Promise<T> {
  const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(blob.iv) }, key, fromHex(blob.data));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function hashProfilePassword(password: string, salt: string, username = '', rounds = PROFILE_HASH_ROUNDS): Promise<string> {
  let data = new TextEncoder().encode(`${salt}:${username}:${password}`);
  for (let round = 0; round < rounds; round++) {
    data = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  }
  return toHex(data);
}

/** True when the password unlocks the profile (always true for public profiles). */
export async function verifyProfilePassword(access: ProfileAccess, username: string, password: string): Promise<boolean> {
  if (access.mode === 'public') return true;
  if (username !== access.username) return false;
  return (await hashProfilePassword(password, access.salt, access.username)) === access.hash;
}

/** The per-profile client id: a key seed kept in the profile record. */
export function encodeProfileSeed(seed: Uint8Array): string {
  return base32Encode(seed);
}

export function decodeProfileSeed(text: string): Uint8Array {
  return base32Decode(text);
}

/** A fresh random key seed for a new profile. */
export function newProfileSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);
  return seed;
}