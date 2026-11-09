// The signing and encoding helpers the hosting pushes need. Everything runs in the page
// itself (and in the desktop app's renderer): digests, HMAC, the two AWS signature schemes
// bucket stores use, gzip, tar and the RS256 JWT a Google service account signs with. No
// server sees a token: every platform API is called straight from the window.
import { sha1hex } from '../../../src/shared/crypto';

const encoder = new TextEncoder();

/** Lower-case hex, the shape every digest-based API wants. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Standard base64 of the bytes (the APIs whose bodies take `base64: true`). */
export function base64Of(data: Uint8Array): string {
  let text = '';
  for (let at = 0; at < data.length; at += 0x8000) text += String.fromCharCode(...data.subarray(at, at + 0x8000));
  return btoa(text);
}

/** The bytes of a standard base64 string (a PEM body, an Azure key). */
export function bytesFromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at);
  return out;
}

function base64urlOf(data: Uint8Array): string {
  return base64Of(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error('This window has no WebCrypto — open the client over http://127.0.0.1 or https.');
  return api;
}

async function hmacBytes(hash: 'SHA-256' | 'SHA-1', key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const api = subtle();
  const imported = await api.importKey('raw', key as unknown as BufferSource, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await api.sign('HMAC', imported, data as unknown as BufferSource));
}

/** HMAC in hex — the Shared Key and Signature V2 string-to-sign formats. */
export async function hmacHexOf(hash: 'SHA-256' | 'SHA-1', key: string | Uint8Array, data: string): Promise<string> {
  return toHex(await hmacBytes(hash, typeof key === 'string' ? encoder.encode(key) : key, encoder.encode(data)));
}

/** HMAC in base64 — what Azure's Shared Key and GCS's GOOG1 signature want. */
export async function hmacBase64Of(hash: 'SHA-256' | 'SHA-1', key: string | Uint8Array, data: string): Promise<string> {
  return base64Of(await hmacBytes(hash, typeof key === 'string' ? encoder.encode(key) : key, encoder.encode(data)));
}

/** gzip, for the platform APIs that take a compressed upload (Firebase and Appwrite). */
export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') throw new Error('This window cannot gzip — use a newer browser (CompressionStream is missing)');
  const body = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** The SHA-256 a bucket store keys an object by. */
export async function sha256HexOf(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', data as unknown as BufferSource)));
}

/** SHA-1 in hex, for the stores whose content address is a SHA-1. */
export function sha1HexOf(data: Uint8Array): string {
  return sha1hex(data);
}

/** A POSIX tar of the given files: what Appwrite wants inside its deployment gzip. */
export function tarOf(entries: { path: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const octal = (value: number, length: number): Uint8Array => encoder.encode(`${value.toString(8).padStart(length - 1, '0').slice(0, length - 1)}\0`);
  const field = (text: string, length: number): Uint8Array => {
    const out = new Uint8Array(length);
    out.set(encoder.encode(text).subarray(0, length), 0);
    return out;
  };
  for (const entry of entries) {
    const header = new Uint8Array(512);
    header.set(field(entry.path, 100), 0);
    header.set(octal(0o644, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(entry.data.length, 12), 124);
    header.set(octal(Math.floor(Date.now() / 1000), 12), 136);
    header.set(field('        ', 8), 148); // the checksum slot, summed as spaces
    header.set(field('0', 1), 156);
    header.set(field('ustar\0', 6), 257);
    header.set(field('00', 2), 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.set(field(`${sum.toString(8).padStart(6, '0')}\0 `, 8), 148);
    blocks.push(header, entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024)); // the two empty blocks that end a tar
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

/** The headers of one AWS Signature V4 request (S3 and every S3-compatible store). */
export async function sigV4(options: {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  payload: Uint8Array;
  headers?: Record<string, string>;
}): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const payloadHash = await sha256HexOf(options.payload);
  const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = stamp.slice(0, 8);
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value.trim();
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((name) => `${name}:${headers[name]}\n`).join('');
  const query = [...url.searchParams]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  const canonicalRequest = [options.method, url.pathname, query, canonicalHeaders, signed.join(';'), payloadHash].join('\n');
  const scope = `${date}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256HexOf(encoder.encode(canonicalRequest))].join('\n');
  const key = await hmacBytes('SHA-256', encoder.encode(`AWS4${options.secretAccessKey}`), encoder.encode(date));
  const regionKey = await hmacBytes('SHA-256', key, encoder.encode(options.region));
  const serviceKey = await hmacBytes('SHA-256', regionKey, encoder.encode(options.service));
  const signingKey = await hmacBytes('SHA-256', serviceKey, encoder.encode('aws4_request'));
  const signature = toHex(await hmacBytes('SHA-256', signingKey, encoder.encode(stringToSign)));
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
  };
}

/** The headers of one Signature V2 request — Cloud Storage's documented GOOG1 scheme. */
export async function sigV2(options: {
  method: string;
  url: string;
  accessKeyId: string;
  secretAccessKey: string;
  contentType?: string;
  /** `AWS` on S3-compatible stores, `GOOG1` on Cloud Storage. */
  prefix?: string;
}): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const date = new Date().toUTCString();
  const stringToSign = [options.method, '', options.contentType ?? '', date, url.pathname].join('\n');
  const signature = await hmacBase64Of('SHA-1', options.secretAccessKey, stringToSign);
  return { date, authorization: `${options.prefix ?? 'AWS'} ${options.accessKeyId}:${signature}` };
}

/** The RS256 JWT a service account signs to trade for a Google OAuth access token. */
export async function rsaSha256Jwt(claims: Record<string, unknown>, privateKeyPem: string): Promise<string> {
  const api = subtle();
  const body = privateKeyPem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '');
  const key = await api.importKey('pkcs8', bytesFromBase64(body) as unknown as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signing = `${base64urlOf(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${base64urlOf(encoder.encode(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(await api.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signing) as unknown as BufferSource));
  return `${signing}.${base64urlOf(signature)}`;
}

