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

export function decodeProfileSeed(text: string): Buffer {
  return base32Decode(text);
}

/** A fresh random key seed for a new profile. */
export function newProfileSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);
  return seed;
}