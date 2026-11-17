import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { request, RemoteError } from '../../shared/node/http.js';
import type { TraceStore } from '../../shared/node/tracing-node.js';
import { signS3Request } from './s3sign.js';

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

/**
 * One line per backend operation — dependency, because a backend is an external store
 * this node calls; a failed operation gets an error line instead. The guard inside keeps
 * the hot per-chunk calls allocation-free while tracing is off.
 */
function backendTrace(
  traces: TraceStore | undefined,
  id: string,
  level: 'dependency' | 'error',
  action: string,
  key: string,
  detail: Record<string, unknown> = {},
  error?: string
): void {
  if (!traces?.recorder.shouldLog(level)) return;
  traces.trace(level, 'provider.backends', action, {
    data: traces.summarize({ backend: id, key: key.slice(0, 16), ...detail }),
    error,
  });
}

export class MemoryBackend implements BlobBackend {
  readonly type = 'memory';
  readonly writable: boolean;
  private blobs = new Map<string, Buffer>();
  constructor(
    readonly id: string,
    config?: CommonConfig,
    private readonly traces?: TraceStore
  ) {
    this.writable = config?.write !== false;
  }
  async put(key: string, data: Buffer) {
    this.blobs.set(key, Buffer.from(data));
    backendTrace(this.traces, this.id, 'dependency', 'put', key, { bytes: data.length });
    return undefined;
  }
  async get(key: string) {
    const data = this.blobs.get(key) ?? null;
    backendTrace(this.traces, this.id, 'dependency', 'get', key, { found: Boolean(data), bytes: data?.length ?? 0 });
    return data;
  }
  async delete(key: string) {
    this.blobs.delete(key);
    backendTrace(this.traces, this.id, 'dependency', 'delete', key);
  }
  async check() {
    return { ok: true, detail: `${this.blobs.size} blobs in memory` };
  }
}

export class LocalBackend implements BlobBackend {
  readonly type = 'local';
  readonly writable: boolean;
  private dir: string;
  constructor(
    readonly id: string,
    config: LocalBackendConfig,
    dataDir: string | null,
    private readonly traces?: TraceStore
  ) {
    this.dir = isAbsolute(config.path) || !dataDir ? config.path : join(dataDir, config.path);
    this.writable = config.write !== false;
  }
  private file(key: string) {
    return join(this.dir, shard(key), key);
  }
  async put(key: string, data: Buffer) {
    const file = this.file(key);
    if (existsSync(file)) {
      backendTrace(this.traces, this.id, 'dependency', 'put', key, { bytes: data.length, existed: true });
      return undefined;
    }
    await mkdir(join(this.dir, shard(key)), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, data);
    await rename(temp, file);
    backendTrace(this.traces, this.id, 'dependency', 'put', key, { bytes: data.length });
    return undefined;
  }
  async get(key: string) {
    try {
      const data = await readFile(this.file(key));
      backendTrace(this.traces, this.id, 'dependency', 'get', key, { found: true, bytes: data.length });
      return data;
    } catch (error) {
      // A missing file is a normal miss; anything else is a read failure that this
      // catch swallows into null.
      const miss = (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR';
      backendTrace(this.traces, this.id, miss ? 'dependency' : 'error', 'get', key, { found: false }, miss ? undefined : (error as Error).message);
      return null;
    }
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
    backendTrace(this.traces, this.id, 'dependency', 'delete', key);
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
    private config: S3BackendConfig,
    private readonly traces?: TraceStore
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
    const headers = signS3Request(
      {
        method,
        url,
        body,
        region: this.config.region,
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      this.traces
    );
    return fetch(url, { method, headers, body, signal: AbortSignal.timeout(60000) });
  }

  /** One dependency line per request, with where it went and how long it took. */
  private traceCall(action: string, key: string, method: string, url: URL, started: number, status: number, detail: Record<string, unknown> = {}): void {
    backendTrace(this.traces, this.id, 'dependency', action, key, { url: url.toString(), method, ms: Date.now() - started, status, ...detail });
  }

  async put(key: string, data: Buffer) {
    const url = this.url(key);
    const started = Date.now();
    const response = await this.send('PUT', url, data);
    if (!response.ok) {
      const message = `S3 PUT ${key}: ${response.status} ${await response.text()}`;
      backendTrace(this.traces, this.id, 'error', 'put', key, { url: url.toString(), method: 'PUT', ms: Date.now() - started, status: response.status }, message);
      throw new Error(message);
    }
    this.traceCall('put', key, 'PUT', url, started, response.status, { bytes: data.length });
    return undefined;
  }
  async get(key: string) {
    const url = this.url(key);
    const started = Date.now();
    const response = await this.send('GET', url);
    if (response.status === 404) {
      this.traceCall('get', key, 'GET', url, started, 404, { found: false });
      return null;
    }
    if (!response.ok) {
      const message = `S3 GET ${key}: ${response.status}`;
      backendTrace(this.traces, this.id, 'error', 'get', key, { url: url.toString(), method: 'GET', ms: Date.now() - started, status: response.status }, message);
      throw new Error(message);
    }
    const data = Buffer.from(await response.arrayBuffer());
    this.traceCall('get', key, 'GET', url, started, response.status, { found: true, bytes: data.length });
    return data;
  }
  async delete(key: string) {
    const url = this.url(key);
    const started = Date.now();
    const response = await this.send('DELETE', url);
    if (!response.ok && response.status !== 404) {
      const message = `S3 DELETE ${key}: ${response.status}`;
      backendTrace(this.traces, this.id, 'error', 'delete', key, { url: url.toString(), method: 'DELETE', ms: Date.now() - started, status: response.status }, message);
      throw new Error(message);
    }
    this.traceCall('delete', key, 'DELETE', url, started, response.status);
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
    private config: WebDavBackendConfig,
    private readonly traces?: TraceStore
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
    const target = `${this.base()}/${dir}/${key}`;
    const started = Date.now();
    if (!this.madeDirs.has(dir)) {
      const made = await fetch(`${this.base()}/${dir}/`, { method: 'MKCOL', headers: this.headers() });
      if (!made.ok && made.status !== 405 && made.status !== 301) {
        const message = `WebDAV MKCOL: ${made.status}`;
        backendTrace(this.traces, this.id, 'error', 'put', key, { url: `${this.base()}/${dir}/`, method: 'MKCOL', ms: Date.now() - started, status: made.status }, message);
        throw new Error(message);
      }
      this.madeDirs.add(dir);
    }
    const response = await fetch(target, { method: 'PUT', headers: this.headers(), body: data });
    if (!response.ok) {
      const message = `WebDAV PUT ${key}: ${response.status}`;
      backendTrace(this.traces, this.id, 'error', 'put', key, { url: target, method: 'PUT', ms: Date.now() - started, status: response.status }, message);
      throw new Error(message);
    }
    backendTrace(this.traces, this.id, 'dependency', 'put', key, { url: target, method: 'PUT', ms: Date.now() - started, status: response.status, bytes: data.length });
    return undefined;
  }
  async get(key: string) {
    const target = `${this.base()}/${shard(key)}/${key}`;
    const started = Date.now();
    const response = await fetch(target, { headers: this.headers() });
    if (response.status === 404) {
      backendTrace(this.traces, this.id, 'dependency', 'get', key, { url: target, method: 'GET', ms: Date.now() - started, found: false, status: 404 });
      return null;
    }
    if (!response.ok) {
      const message = `WebDAV GET ${key}: ${response.status}`;
      backendTrace(this.traces, this.id, 'error', 'get', key, { url: target, method: 'GET', ms: Date.now() - started, status: response.status }, message);
      throw new Error(message);
    }
    const data = Buffer.from(await response.arrayBuffer());
    backendTrace(this.traces, this.id, 'dependency', 'get', key, { url: target, method: 'GET', ms: Date.now() - started, found: true, status: response.status, bytes: data.length });
    return data;
  }
  async delete(key: string) {
    const target = `${this.base()}/${shard(key)}/${key}`;
    const started = Date.now();
    const response = await fetch(target, { method: 'DELETE', headers: this.headers() });
    // The status is ignored on purpose (delete is idempotent) — a failing one is still
    // worth an error line so it is not invisible.
    if (!response.ok && response.status !== 404) backendTrace(this.traces, this.id, 'error', 'delete', key, { url: target, method: 'DELETE', ms: Date.now() - started, status: response.status }, `WebDAV DELETE ${key}: ${response.status}`);
    else backendTrace(this.traces, this.id, 'dependency', 'delete', key, { url: target, method: 'DELETE', ms: Date.now() - started, status: response.status });
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
    private config: IpfsBackendConfig,
    private readonly traces?: TraceStore
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
    const target = this.api('add?cid-version=1&pin=true&quieter=true');
    const started = Date.now();
    const response = await fetch(target, {
      method: 'POST',
      body: form,
      headers: this.headers(),
    });
    if (!response.ok) {
      const message = `IPFS add: ${response.status}`;
      backendTrace(this.traces, this.id, 'error', 'put', key, { url: target, method: 'POST', ms: Date.now() - started, status: response.status }, message);
      throw new Error(message);
    }
    const text = await response.text();
    const result = JSON.parse(text.trim().split('\n').pop() ?? '{}') as { Hash?: string };
    if (!result.Hash) {
      backendTrace(this.traces, this.id, 'error', 'put', key, {}, 'IPFS add returned no hash');
      throw new Error('IPFS add returned no hash');
    }
    backendTrace(this.traces, this.id, 'dependency', 'put', key, { url: target, method: 'POST', ms: Date.now() - started, status: response.status, bytes: data.length });
    return result.Hash;
  }
  async get(_key: string, locator?: string) {
    if (!locator) {
      backendTrace(this.traces, this.id, 'dependency', 'get', _key, { found: false });
      return null;
    }
    const target = this.config.gatewayUrl ? `${this.config.gatewayUrl.replace(/\/$/, '')}/ipfs/${locator}` : this.api(`cat?arg=${locator}`);
    const started = Date.now();
    const response = this.config.gatewayUrl
      ? await fetch(target)
      : await fetch(target, { method: 'POST', headers: this.headers() });
    if (!response.ok) {
      // No locator content at404; anything else is a swallowed failure.
      if (response.status !== 404) backendTrace(this.traces, this.id, 'error', 'get', _key, { url: target, method: 'POST', ms: Date.now() - started, status: response.status }, `IPFS get: ${response.status}`);
      else backendTrace(this.traces, this.id, 'dependency', 'get', _key, { url: target, method: 'POST', ms: Date.now() - started, found: false, status: 404 });
      return null;
    }
    const data = Buffer.from(await response.arrayBuffer());
    backendTrace(this.traces, this.id, 'dependency', 'get', _key, { url: target, method: 'POST', ms: Date.now() - started, found: true, status: response.status, bytes: data.length });
    return data;
  }
  async delete(_key: string, locator?: string) {
    if (locator) {
      const target = this.api(`pin/rm?arg=${locator}`);
      const started = Date.now();
      const response = await fetch(target, { method: 'POST', headers: this.headers() });
      // Unpin failures are ignored on purpose — the trace line keeps them visible.
      if (!response.ok) backendTrace(this.traces, this.id, 'error', 'delete', _key, { url: target, method: 'POST', ms: Date.now() - started, status: response.status }, `IPFS pin/rm: ${response.status}`);
      else backendTrace(this.traces, this.id, 'dependency', 'delete', _key, { url: target, method: 'POST', ms: Date.now() - started, status: response.status });
    }
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
    private config: HttpBackendConfig,
    private readonly traces?: TraceStore
  ) {}
  async put(): Promise<string | undefined> {
    throw new Error('HTTP mirrors are read-only');
  }
  async get(key: string) {
    const target = `${this.config.baseUrl.replace(/\/$/, '')}/${key}`;
    const started = Date.now();
    try {
      const response = await request(target, {
        headers: this.config.headers,
        timeoutMs: 30000,
      });
      const data = Buffer.from(await response.arrayBuffer());
      backendTrace(this.traces, this.id, 'dependency', 'get', key, { url: target, method: 'GET', ms: Date.now() - started, status: response.status, found: true, bytes: data.length });
      return data;
    } catch (error) {
      if (error instanceof RemoteError && error.status === 404) {
        backendTrace(this.traces, this.id, 'dependency', 'get', key, { url: target, method: 'GET', ms: Date.now() - started, found: false, status: 404 });
        return null;
      }
      // Rethrown to the caller; the failure is traced here because this catch knows
      // which mirror it came from.
      backendTrace(this.traces, this.id, 'error', 'get', key, { url: target, method: 'GET', ms: Date.now() - started, status: error instanceof RemoteError ? error.status : undefined }, (error as Error).message);
      throw error;
    }
  }
  async delete() {}
  async check() {
    return { ok: true, detail: this.config.baseUrl };
  }
}

/** Reads chunks and manifests from another provider node (a pull-through mirror). */
export class ProviderBackend implements BlobBackend {
  readonly type = 'provider';
  readonly writable = false;
  constructor(
    readonly id: string,
    private fetchChunk: (key: string) => Promise<Buffer | null>,
    private describe: () => Promise<{ ok: boolean; detail: string }>,
    private readonly traces?: TraceStore
  ) {}
  async put(): Promise<string | undefined> {
    throw new Error('Other providers are read-only backends');
  }
  async get(key: string) {
    if (!key.startsWith('vc1') && !key.startsWith('m-vs1')) {
      backendTrace(this.traces, this.id, 'dependency', 'get', key, { found: false });
      return null;
    }
    try {
      const data = await this.fetchChunk(key);
      backendTrace(this.traces, this.id, 'dependency', 'get', key, { found: Boolean(data), bytes: data?.length ?? 0 });
      return data;
    } catch (error) {
      backendTrace(this.traces, this.id, 'error', 'get', key, {}, (error as Error).message);
      throw error;
    }
  }
  async delete() {}
  async check() {
    return this.describe();
  }
}
