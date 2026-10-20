// Lowercase RFC 4648 base32 without padding: case-insensitive and safe in URLs,
// file names and hostnames, which is why ids (keys, content, chunks) use it.
// Pure bytes and strings only — the browser has no Node globals, and these run in
// every client that verifies signatures and hashes.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toLowerCase().replace(/=+$/, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Invalid base32 character "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  // Strict canonical form (RFC 4648): every byte string has exactly one encoding, so
  // ids cannot be mangled into other spellings of the same id and typos surface instead
  // of silently decoding. The last character may carry up to 4 unused padding bits, which
  // must be zero, and it must always contribute to a byte (no dangling whole characters).
  if (bits >= 5) throw new Error('Invalid base32 length');
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) throw new Error('Invalid base32 padding bits');
  return new Uint8Array(out);
}

export function base64url(bytes: Uint8Array): string {
  // A preallocated buffer of characters, then one string per block: appending per byte
  // leaves a long rope of tiny strings behind, which costs far more than the result.
  const chars = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let at = 0;
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      const code = BASE64.charCodeAt((value >>> (bits - 6)) & 63);
      chars[at++] = code === 43 ? 45 : code === 47 ? 95 : code; // +/ as -_
      bits -= 6;
    }
  }
  if (bits > 0) {
    const code = BASE64.charCodeAt((value << (6 - bits)) & 63);
    chars[at++] = code === 43 ? 45 : code === 47 ? 95 : code;
  }
  let out = '';
  for (let i = 0; i < at; i += 8192) out += String.fromCharCode(...chars.subarray(i, Math.min(at, i + 8192)));
  return out;
}

const BASE64_INDEX = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i++) table[BASE64.charCodeAt(i)] = i;
  return table;
})();

export function fromBase64url(text: string): Uint8Array {
  // Padding is optional (RFC 4648 §3.2): an Ed25519 signature is 86 characters, not a
  // multiple of four. Decoders that insist on padded input — like the base64 decoder of
  // browser Buffer polyfills — reject every signature, so decode by bits instead.
  const clean = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const index = code < 128 ? BASE64_INDEX[code] : -1;
    if (index < 0) throw new Error(`Invalid base64 character "${clean[i]}"`);
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      out[at++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return at === out.length ? out : out.slice(0, at);
}

/** JSON with sorted object keys and no whitespace, so equal values always hash and sign the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite number in canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
