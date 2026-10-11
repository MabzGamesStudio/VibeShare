import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { request, RemoteError } from '../../shared/http.js';
import { signS3Request } from './s3sign.js';
import { sha256hex } from '../../shared/crypto.js';

/**
 * Where a provider keeps blobs (chunks and manifests). A provider can use several
 * at once — its own disk, S3-compatible buckets, WebDAV, IPFS, mirrors, other
 * providers — and reads from them in priority order.
 */
export interface BlobBackend {
  readonly id: string;
  readonly type: string;
  readonly writable: boolean;
  /** Stores a blob; returns a locator when the backend names blobs itself (IPFS CIDs). */
  put(key: string, data: Buffer): Promise<string | undefined>;
  get(key: string, locator?: string): Promise<Buffer | null>;
  delete(key: string, locator?: string): Promise<void>;
  check(): Promise<{ ok: boolean; detail: string }>;
}

interface CommonConfig {
  id: string;
  /** Lower is tried first (default 10). */
  priority?: number;
  /** Set false to only read from this backend. */
  write?: boolean;
}

export interface LocalBackendConfig extends CommonConfig {
  type: 'local';
  /** Directory; relative paths are inside the node's data directory. */
  path: string;
}

/** AWS S3 and anything speaking its API: Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO, Storj, Filebase, … */
export interface S3BackendConfig extends CommonConfig {
  type: 's3';
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  /** https://endpoint/bucket/key (default) instead of https://bucket.endpoint/key. */
  pathStyle?: boolean;
}

/** Nextcloud, ownCloud, Box, pCloud, Koofr, `rclone serve webdav` (Google Drive, Dropbox, OneDrive…), … */
export interface WebDavBackendConfig extends CommonConfig {
  type: 'webdav';
  url: string;
  username?: string;
  password?: string;
}

/** A Kubo (go-ipfs) node's RPC API; reads can go through a gateway. */
export interface IpfsBackendConfig extends CommonConfig {
  type: 'ipfs';
  apiUrl: string;
  gatewayUrl?: string;
  /** Authorization header for hosted RPC endpoints. */
  authorization?: string;
}

/** Read-only: GET {baseUrl}/{key} from any static host or CDN. */
export interface HttpBackendConfig extends CommonConfig {
  type: 'http';
  baseUrl: string;
  headers?: Record<string, string>;
}

/** Read-only: another VibeShare provider, paid with this node's own account there. */
export interface ProviderBackendConfig extends CommonConfig {
  type: 'provider';
  /** Node reference or URL of the other provider. */
  ref: string;
}

export interface MemoryBackendConfig extends CommonConfig {
  type: 'memory';
}

export type BackendConfig =
  | LocalBackendConfig
  | S3BackendConfig
  | WebDavBackendConfig
  | IpfsBackendConfig
  | HttpBackendConfig
  | ProviderBackendConfig
  | MemoryBackendConfig;

function shard(key: string): string {
  return key.slice(3, 5) || '00';
}

export class MemoryBackend implements BlobBackend {
  readonly type = 'memory';
  readonly writable: boolean;
  private blobs = new Map<string, Buffer>();
  constructor(readonly id: string, config?: CommonConfig) {
    this.writable = config?.write !== false;
  }
  async put(key: string, data: Buffer) {
    this.blobs.set(key, Buffer.from(data));
    return undefined;
  }
  async get(key: string) {
    return this.blobs.get(key) ?? null;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
  async check() {
    return { ok: true, detail: `${this.blobs.size} blobs in memory` };
  }
}

export class LocalBackend implements BlobBackend {
  readonly type = 'local';
  readonly writable: boolean;
  private dir: string;
  constructor(readonly id: string, config: LocalBackendConfig, dataDir: string | null) {
    this.dir = isAbsolute(config.path) || !dataDir ? config.path : join(dataDir, config.path);
    this.writable = config.write !== false;
  }
  private file(key: string) {
    return join(this.dir, shard(key), key);
  }
  async put(key: string, data: Buffer) {
    const file = this.file(key);
    if (existsSync(file)) return undefined;
    await mkdir(join(this.dir, shard(key)), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, data);
    await rename(temp, file);
    return undefined;
  }
  async get(key: string) {
    try {
      return await readFile(this.file(key));
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
  async check() {
    try {
      await mkdir(this.dir, { recursive: true });
      const stats = await statfs(this.dir);
      const free = (stats.bavail * stats.bsize) / 1024 ** 3;
      return { ok: true, detail: `${this.dir} (${free.toFixed(1)} GiB free)` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

export class S3Backend implements BlobBackend {
  readonly type = 's3';
  readonly writable: boolean;
  constructor(
    readonly id: string,
    private config: S3BackendConfig
  ) {
    this.writable = config.write !== false;
  }

  private url(key: string): URL {
    const endpoint = new URL(this.config.endpoint);
    const object = `${this.config.prefix ?? ''}${key}`;
    if (this.config.pathStyle === false) {
      endpoint.hostname = `${this.config.bucket}.${endpoint.hostname}`;
      endpoint.pathname = `/${object}`;
    } else {
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${this.config.bucket}/${object}`;
    }
    return endpoint;
  }

  private async send(method: string, url: URL, body?: Buffer): Promise<Response> {
    const headers = signS3Request({
      method,
      url,
      body,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
    });
    return fetch(url, { method, headers, body, signal: AbortSignal.timeout(60000) });
  }

  async put(key: string, data: Buffer) {
    const response = await this.send('PUT', this.url(key), data);
    if (!response.ok) throw new Error(`S3 PUT ${key}: ${response.status} ${await response.text()}`);
    return undefined;
  }
  async get(key: string) {
    const response = await this.send('GET', this.url(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`S3 GET ${key}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  async delete(key: string) {
    const response = await this.send('DELETE', this.url(key));
    if (!response.ok && response.status !== 404) throw new Error(`S3 DELETE ${key}: ${response.status}`);
  }
  async check() {
    try {
      const url = this.url('');
      url.pathname = url.pathname.replace(/\/$/, '') || '/';
      url.searchParams.set('list-type', '2');
      url.searchParams.set('max-keys', '1');
      const response = await this.send('GET', url);
      return { ok: response.ok, detail: response.ok ? `bucket ${this.config.bucket}` : `${response.status} ${response.statusText}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

export class WebDavBackend implements BlobBackend {
  readonly type = 'webdav';
  readonly writable: boolean;
  private madeDirs = new Set<string>();
  constructor(
    readonly id: string,
    private config: WebDavBackendConfig
  ) {
    this.writable = config.write !== false;
  }
  private headers(): Record<string, string> {
    if (!this.config.username) return {};
    const basic = Buffer.from(`${this.config.username}:${this.config.password ?? ''}`).toString('base64');
    return { authorization: `Basic ${basic}` };
  }
  private base(): string {
    return this.config.url.replace(/\/$/, '');
  }
  async put(key: string, data: Buffer) {
    const dir = shard(key);
    if (!this.madeDirs.has(dir)) {
      const made = await fetch(`${this.base()}/${dir}/`, { method: 'MKCOL', headers: this.headers() });
      if (!made.ok && made.status !== 405 && made.status !== 301) throw new Error(`WebDAV MKCOL: ${made.status}`);
      this.madeDirs.add(dir);
    }
    const response = await fetch(`${this.base()}/${dir}/${key}`, { method: 'PUT', headers: this.headers(), body: data });
    if (!response.ok) throw new Error(`WebDAV PUT ${key}: ${response.status}`);
    return undefined;
  }
  async get(key: string) {
    const response = await fetch(`${this.base()}/${shard(key)}/${key}`, { headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`WebDAV GET ${key}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  async delete(key: string) {
    await fetch(`${this.base()}/${shard(key)}/${key}`, { method: 'DELETE', headers: this.headers() });
  }
  async check() {
    try {
      const response = await fetch(`${this.base()}/`, { method: 'PROPFIND', headers: { ...this.headers(), depth: '0' } });
      return { ok: response.ok || response.status === 207, detail: `${response.status} ${response.statusText}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

export class IpfsBackend implements BlobBackend {
  readonly type = 'ipfs';
  readonly writable: boolean;
  constructor(
    readonly id: string,
    private config: IpfsBackendConfig
  ) {
    this.writable = config.write !== false;
  }
  private api(path: string): string {
    return `${this.config.apiUrl.replace(/\/$/, '')}/api/v0/${path}`;
  }
  private headers(): Record<string, string> {
    return this.config.authorization ? { authorization: this.config.authorization } : {};
  }
  async put(key: string, data: Buffer) {
    const form = new FormData();
    form.append('file', new Blob([data]), key);
    const response = await fetch(this.api('add?cid-version=1&pin=true&quieter=true'), {
      method: 'POST',
      body: form,
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`IPFS add: ${response.status}`);
    const text = await response.text();
    const result = JSON.parse(text.trim().split('\n').pop() ?? '{}') as { Hash?: string };
    if (!result.Hash) throw new Error('IPFS add returned no hash');
    return result.Hash;
  }
  async get(_key: string, locator?: string) {
    if (!locator) return null;
    const response = this.config.gatewayUrl
      ? await fetch(`${this.config.gatewayUrl.replace(/\/$/, '')}/ipfs/${locator}`)
      : await fetch(this.api(`cat?arg=${locator}`), { method: 'POST', headers: this.headers() });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }
  async delete(_key: string, locator?: string) {
    if (locator) await fetch(this.api(`pin/rm?arg=${locator}`), { method: 'POST', headers: this.headers() });
  }
  async check() {
    try {
      const response = await fetch(this.api('version'), { method: 'POST', headers: this.headers() });
      const body = (await response.json()) as { Version?: string };
      return { ok: response.ok, detail: `Kubo ${body.Version ?? '?'}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

export class HttpBackend implements BlobBackend {
  readonly type = 'http';
  readonly writable = false;
  constructor(
    readonly id: string,
    private config: HttpBackendConfig
  ) {}
  async put(): Promise<string | undefined> {
    throw new Error('HTTP mirrors are read-only');
  }
  async get(key: string) {
    try {
      const response = await request(`${this.config.baseUrl.replace(/\/$/, '')}/${key}`, {
        headers: this.config.headers,
        timeoutMs: 30000,
      });
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof RemoteError && error.status === 404) return null;
      throw error;
    }
  }
  async delete() {}
  async check() {
    return { ok: true, detail: this.config.baseUrl };
  }
}

/** Fetches chunks from another provider node. The constructor gets a fetcher bound to that node. */
export class ProviderBackend implements BlobBackend {
  readonly type = 'provider';
  readonly writable = false;
  constructor(
    readonly id: string,
    private fetchChunk: (key: string) => Promise<Buffer | null>,
    private describe: () => Promise<{ ok: boolean; detail: string }>
  ) {}
  async put(): Promise<string | undefined> {
    throw new Error('Other providers are read-only backends');
  }
  async get(key: string) {
    if (!key.startsWith('vc1')) return null;
    return this.fetchChunk(key);
  }
  async delete() {}
  async check() {
    return this.describe();
  }
}

/** Content hash check used after reading from any backend that is not trusted to return the right bytes. */
export function matchesKey(key: string, data: Buffer, chunkIdOf: (data: Buffer) => string): boolean {
  if (key.startsWith('vc1')) return chunkIdOf(data) === key;
  return sha256hex(data).length > 0;
}
