// Parsing the "send credits to …" field. Browser-safe: no Node imports.
//
// A recipient is either a VibeShare key id (`vk1…`, the account id on every node) or a
// creator id such as `yt:UCX6OQ3DkcsbYNE6H8uQQuVA`. People paste both in different shapes:
// the raw id, a percent-encoded id (`youtube%3AUCX…`), or a link to a creator page. This
// module turns all of them into one canonical form; resolving a creator id to the account
// that receives the credits is the node's job (it may know the creator's keys).

import { isKeyId } from './crypto.js';

export interface CreditRecipient {
  kind: 'key' | 'creator';
  /** The canonical id: a `vk1…` key or a creator id (`yt:…`, `name:…`). */
  id: string;
}

/** Percent-decoding that never throws (a pasted id may contain a stray `%`). */
function decode(text: string): string {
  let value = text.trim();
  for (let round = 0; round < 3; round++) {
    if (!/%[0-9a-f]{2}/i.test(value)) break;
    try {
      const next = decodeURIComponent(value);
      if (next === value) break;
      value = next;
    } catch {
      break;
    }
  }
  return value.trim();
}

/** A platform creator id: a short scheme, a colon, and a non-empty value. */
const CREATOR_ID = /^[a-z][a-z0-9+.-]{0,31}:[^\s/]+$/i;

/**
 * Parses one recipient: a key id, a creator id, a percent-encoded form of either, or a
 * link to a creator page (`…/creator/<id>`, `…/@handle` is NOT guessed). Returns null when
 * the text cannot name a recipient — the caller shows the error.
 */
export function parseCreditRecipient(text: string): CreditRecipient | null {
  const value = decode(String(text ?? ''));
  if (!value) return null;
  if (isKeyId(value)) return { kind: 'key', id: value };
  if (/^https?:\/\//i.test(value)) {
    // A creator page on a VibeShare node: the last path segment is the creator id.
    try {
      const url = new URL(value);
      const segments = url.pathname.split('/').filter(Boolean);
      const at = segments.findIndex((segment) => segment === 'creator' || segment === 'creators');
      const id = (at >= 0 ? segments[at + 1] : segments[segments.length - 1]) ?? '';
      const parsed = decode(id);
      if (isKeyId(parsed)) return { kind: 'key', id: parsed };
      if (CREATOR_ID.test(parsed)) return { kind: 'creator', id: parsed };
    } catch {
      return null;
    }
    return null;
  }
  if (CREATOR_ID.test(value)) return { kind: 'creator', id: value };
  return null;
}

/** True when the text can be sent to (used to enable/disable the send button). */
export function isCreditRecipient(text: string): boolean {
  return parseCreditRecipient(text) !== null;
}
