// Tor for clients and nodes, without extra dependencies:
//  - a SOCKS5 client (RFC 1928/1929) that lets Tor resolve host names, so DNS never leaks;
//  - a fetch() that sends HTTP(S) requests through it;
//  - routing: which URLs go through Tor (only .onion addresses, or everything);
//  - onion services: publishing a node at a .onion address through Tor's control port.
// Node only (sockets); the web client relies on Tor Browser instead.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { log } from './log.js';

export interface SocksAddress {
  host: string;
  port: number;
}

/** Where Tor usually listens: the tor service, then Tor Browser. */
export const DEFAULT_SOCKS_PORTS: SocksAddress[] = [
  { host: '127.0.0.1', port: 9050 },
  { host: '127.0.0.1', port: 9150 },
];

/** "127.0.0.1:9050", "socks5h://localhost:9150", "[::1]:9050" → host and port. */
export function parseSocksAddress(text: string, defaultPort = 9050): SocksAddress {
  const clean = text.trim().replace(/^socks5h?:\/\//i, '').replace(/\/+$/, '');
  const match = clean.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? clean.match(/^([^:]+)(?::(\d+))?$/);
  if (!match) throw new Error(`Not a host:port address: ${text}`);
  const port = match[2] ? Number(match[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Bad port in ${text}`);
  return { host: match[1], port };
}

export function isOnionHost(host: string): boolean {
  return /\.onion\.?$/i.test(host);
}

export function isOnionUrl(url: string | URL): boolean {
  try {
    return isOnionHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isLocalHost(host: string): boolean {
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean === 'localhost' || clean.endsWith('.localhost')) return true;
  if (isIP(clean) === 4) return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(clean);
  if (isIP(clean) === 6) return clean === '::1' || /^f[cd]|^fe80/.test(clean);
  return false;
}

// ---------------------------------------------------------------------------- SOCKS5

const SOCKS_ERRORS: Record<number, string> = {
  0x01: 'general failure',
  0x02: 'connection not allowed',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'timed out',
  0x07: 'command not supported',
  0x08: 'address type not supported',
  // Tor's own answers about onion services
  0xf0: 'onion service not found (it may be offline)',
  0xf1: 'onion service descriptor is invalid',
  0xf2: 'onion service introduction failed',
  0xf3: 'onion service rendezvous failed',
  0xf4: 'onion service needs client authorization',
  0xf5: 'wrong onion service client authorization',
  0xf6: 'invalid onion address',
  0xf7: 'onion service introduction timed out',
};

export class TorError extends Error {
  override name = 'TorError';

  constructor(
    message: string,
    /** The proxy could not be reached at all (Tor is not running there). */
    readonly proxyDown = false
  ) {
    super(message);
  }
}

/** Reads exactly n bytes from a paused socket. */
function readExactly(socket: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const chunk = socket.read(n) as Buffer | null;
      if (chunk) {
        cleanup();
        resolve(chunk);
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new TorError('The Tor proxy closed the connection'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('readable', attempt);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
    };
    socket.on('readable', attempt);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onError);
    attempt();
  });
}

export interface SocksConnectOptions {
  /**
   * Tor keeps streams with different credentials on different circuits (IsolateSOCKSAuth),
   * so a node cannot link requests to it with requests to other nodes by exit address.
   */
  isolation?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Opens a TCP connection to host:port through a SOCKS5 proxy; the proxy resolves the name. */
export async function socksConnect(proxy: SocksAddress, host: string, port: number, options: SocksConnectOptions = {}): Promise<Socket> {
  const socket = netConnect({ host: proxy.host, port: proxy.port });
  socket.pause();
  const abort = () => socket.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new TorError('Aborted'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => socket.destroy(new TorError(`Tor did not connect to ${host} in time`)), options.timeoutMs ?? 60_000);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', (error: NodeJS.ErrnoException) =>
        reject(
          error.code === 'ECONNREFUSED'
            ? new TorError(`Tor is not running at ${proxy.host}:${proxy.port} (no SOCKS proxy there)`, true)
            : error
        )
      );
    });
    const user = options.isolation ? Buffer.from(options.isolation).subarray(0, 255) : null;
    socket.write(Buffer.from(user ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    const [version, method] = await readExactly(socket, 2);
    if (version !== 0x05) throw new TorError(`${proxy.host}:${proxy.port} is not a SOCKS5 proxy`, true);
    if (method === 0x02) {
      const name = user ?? Buffer.from('vibeshare');
      const pass = Buffer.from('x');
      socket.write(Buffer.concat([Buffer.from([0x01, name.length]), name, Buffer.from([pass.length]), pass]));
      const [, status] = await readExactly(socket, 2);
      if (status !== 0x00) throw new TorError('The SOCKS proxy refused the credentials');
    } else if (method !== 0x00) {
      throw new TorError('The SOCKS proxy wants an authentication method VibeShare does not support', true);
    }
    const bare = host.replace(/^\[|\]$/g, '');
    let address: Buffer;
    if (isIP(bare) === 4) address = Buffer.from([0x01, ...bare.split('.').map(Number)]);
    else if (isIP(bare) === 6) address = Buffer.concat([Buffer.from([0x04]), ipv6Bytes(bare)]);
    else {
      const name = Buffer.from(bare);
      if (name.length > 255) throw new TorError('Host name too long');
      address = Buffer.concat([Buffer.from([0x03, name.length]), name]);
    }
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, Buffer.from([port >> 8, port & 0xff])]));
    const head = await readExactly(socket, 4);
    if (head[1] !== 0x00) throw new TorError(`Tor could not reach ${host}: ${SOCKS_ERRORS[head[1]] ?? `error ${head[1]}`}`);
    const rest = head[3] === 0x01 ? 4 + 2 : head[3] === 0x04 ? 16 + 2 : (await readExactly(socket, 1))[0] + 2;
    await readExactly(socket, rest);
    return socket;
  } catch (error) {
    socket.destroy();
    if (options.signal?.aborted) throw options.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

function ipv6Bytes(address: string): Buffer {
  const [head, tail = ''] = address.split('::');
  const parse = (part: string) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  const groups = address.includes('::') ? [...left, ...new Array(8 - left.length - right.length).fill(0), ...right] : left;
  const bytes = Buffer.alloc(16);
  groups.forEach((group, i) => bytes.writeUInt16BE(group, i * 2));
  return bytes;
}

// ---------------------------------------------------------------------------- fetch over Tor

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface TorFetchOptions {
  /** The SOCKS proxy, or a function finding it (see TorProxy). */
  proxy: SocksAddress | (() => Promise<SocksAddress>);
  /** Credentials for circuit isolation, per URL (default: one circuit family per host). */
  isolation?: (url: URL) => string | undefined;
  /** Time to connect through Tor (building circuits to onion services takes a while). */
  connectTimeoutMs?: number;
}

/**
 * A fetch() whose requests go through Tor. It supports what VibeShare uses: any method,
 * headers, string/byte bodies, AbortSignal, and redirect "follow", "manual" or "error".
 */
export function torFetch(options: TorFetchOptions): typeof fetch {
  const proxyOf = typeof options.proxy === 'function' ? options.proxy : async () => options.proxy as SocksAddress;
  const send = async (request: Request, body: Buffer | undefined, hops: number): Promise<Response> => {
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`Cannot fetch ${url.protocol} URLs through Tor`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const signal = request.signal;
    signal?.throwIfAborted();
    const raw = await socksConnect(await proxyOf(), host, port, {
      isolation: options.isolation ? options.isolation(url) : `vibeshare:${url.host}`,
      timeoutMs: options.connectTimeoutMs,
      signal,
    });
    const socket =
      url.protocol === 'https:'
        ? await new Promise<Socket>((resolve, reject) => {
            const secure = tlsConnect({ socket: raw, servername: isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] });
            secure.once('secureConnect', () => resolve(secure));
            secure.once('error', reject);
          })
        : raw.resume(); // (paused for the SOCKS handshake; the HTTP parser reads it from here)
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    headers.host = url.host;
    // (Not asking for compression: the body is passed on as it comes.)
    delete headers['accept-encoding'];
    if (body) headers['content-length'] = String(body.length);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        createConnection: () => socket,
      });
      const abort = () => outgoing.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      outgoing.once('response', (incoming) => {
        incoming.once('close', () => signal?.removeEventListener('abort', abort));
        resolve(incoming);
      });
      outgoing.once('error', (error) => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      });
      outgoing.end(body);
    });
    const status = response.statusCode ?? 502;
    const location = response.headers.location;
    if (REDIRECTS.has(status) && location && request.redirect !== 'manual') {
      response.resume();
      socket.destroy();
      if (request.redirect === 'error') throw new TypeError(`Redirected to ${location}`);
      if (hops >= 20) throw new TypeError('Too many redirects');
      const next = new URL(location, url);
      const asGet = status === 303 || ((status === 301 || status === 302) && request.method === 'POST');
      const nextHeaders = new Headers(request.headers);
      // Like fetch: credentials never follow a redirect to another site.
      if (next.origin !== url.origin) for (const name of ['authorization', 'cookie', 'proxy-authorization']) nextHeaders.delete(name);
      if (asGet) for (const name of ['content-type', 'content-length']) nextHeaders.delete(name);
      const nextRequest = new Request(next, {
        method: asGet ? 'GET' : request.method,
        headers: nextHeaders,
        redirect: request.redirect,
        signal: request.signal,
      });
      return send(nextRequest, asGet ? undefined : body, hops + 1);
    }
    const responseHeaders = new Headers();
    for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
    response.once('end', () => socket.end());
    const empty = request.method === 'HEAD' || status === 204 || status === 304 || status < 200;
    if (empty) response.resume();
    const result = new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
      status: status < 200 ? 502 : status,
      statusText: response.statusMessage,
      headers: responseHeaders,
    });
    Object.defineProperty(result, 'url', { value: url.href });
    return result;
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
    return send(request, body, 0);
  }) as typeof fetch;
}

/**
 * Finds Tor's SOCKS port: the configured address, or the usual ones (the tor service on
 * 9050, Tor Browser on 9150) when none is set. Remembers what worked for a while.
 */
export class TorProxy {
  private found: { address: SocksAddress; until: number } | null = null;

  constructor(private readonly configured: () => string) {}

  async address(): Promise<SocksAddress> {
    const text = this.configured().trim();
    if (text) return parseSocksAddress(text);
    if (this.found && this.found.until > Date.now()) return this.found.address;
    for (const candidate of DEFAULT_SOCKS_PORTS) {
      if (await reachable(candidate)) {
        this.found = { address: candidate, until: Date.now() + 60_000 };
        return candidate;
      }
    }
    throw new TorError('Tor is not running: start Tor (or Tor Browser), or set its SOCKS address', true);
  }
}

function reachable(address: SocksAddress): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: address.host, port: address.port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Which requests go through Tor: none (onion addresses still need it), onion addresses only, or all. */
export type TorMode = 'off' | 'onion' | 'all';

/**
 * Picks the transport for a URL: Tor for .onion addresses (in every mode but "off"), and
 * for everything else in "all" mode except local addresses (a local IPFS daemon, a node on
 * this machine), which Tor could not reach anyway.
 */
export class TorRouter {
  readonly proxy: TorProxy;
  private readonly tor: typeof fetch;

  constructor(
    private readonly settings: () => { mode: TorMode; proxy: string },
    options: { connectTimeoutMs?: number } = {}
  ) {
    this.proxy = new TorProxy(() => this.settings().proxy);
    this.tor = torFetch({ proxy: () => this.proxy.address(), connectTimeoutMs: options.connectTimeoutMs });
  }

  /** Whether a request to this URL goes through Tor. */
  routes(url: string | URL): boolean {
    const { mode } = this.settings();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (isOnionHost(parsed.hostname)) return mode !== 'off';
    return mode === 'all' && !isLocalHost(parsed.hostname);
  }

  /** A fetch that routes each request by its URL. */
  readonly fetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (this.routes(url)) return this.tor(input, init);
    if (isOnionUrl(url)) {
      return Promise.reject(new TorError(`${new URL(url).hostname} is a Tor onion service: turn Tor on to reach it`));
    }
    return fetch(input, init);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------- onion services

export interface OnionServiceOptions {
  /** Tor's control port, e.g. "127.0.0.1:9051". */
  controlPort: string;
  /** HashedControlPassword's password, when Tor uses one; otherwise cookie or no authentication. */
  password?: string;
  /** Port of the onion address (80: http://<address>.onion/). */
  virtualPort: number;
  /** Where the node listens. */
  target: SocksAddress;
  /** Saved private key ("ED25519-V3:…"), so the address stays the same across restarts. */
  loadKey(): string | undefined;
  saveKey(key: string): void;
  onReady(address: string): void;
}

/** A line-based Tor control connection (control-spec.txt). */
class ControlConnection {
  private buffer = '';
  private waiting: ((reply: { code: number; lines: string[] }) => void)[] = [];
  private lines: string[] = [];
  closed: Promise<void>;

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => this.receive(data));
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()));
  }

  static async open(address: SocksAddress): Promise<ControlConnection> {
    const socket = netConnect({ host: address.host, port: address.port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.on('error', () => undefined);
    return new ControlConnection(socket);
  }

  private receive(data: string): void {
    this.buffer += data;
    let end: number;
    while ((end = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.lines.push(line);
      if (/^\d{3} /.test(line)) {
        const lines = this.lines;
        this.lines = [];
        const code = Number(line.slice(0, 3));
        if (code === 650) continue; // asynchronous event
        this.waiting.shift()?.({ code, lines: lines.map((text) => text.slice(4)) });
      }
    }
  }

  async command(text: string): Promise<string[]> {
    const reply = await new Promise<{ code: number; lines: string[] }>((resolve, reject) => {
      if (this.socket.destroyed) return reject(new TorError('The Tor control connection is closed'));
      this.waiting.push(resolve);
      this.socket.write(`${text}\r\n`);
    });
    if (reply.code !== 250) throw new TorError(`Tor refused ${text.split(' ')[0]}: ${reply.lines.join(' ')}`);
    return reply.lines;
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

function quoted(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function authenticate(control: ControlConnection, password: string | undefined): Promise<void> {
  const info = (await control.command('PROTOCOLINFO 1')).join('\n');
  const methods = (info.match(/METHODS=([\w,]+)/)?.[1] ?? '').split(',');
  const cookieFile = info.match(/COOKIEFILE="((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, '$1');
  if (password) {
    await control.command(`AUTHENTICATE ${quoted(password)}`);
  } else if (methods.includes('NULL')) {
    await control.command('AUTHENTICATE');
  } else if (cookieFile && (methods.includes('COOKIE') || methods.includes('SAFECOOKIE'))) {
    let cookie: Buffer;
    try {
      cookie = readFileSync(cookieFile);
    } catch (error) {
      throw new TorError(`Cannot read Tor's control cookie ${cookieFile} (${(error as Error).message}); set a control password instead`);
    }
    if (methods.includes('COOKIE')) {
      await control.command(`AUTHENTICATE ${cookie.toString('hex')}`);
    } else {
      const clientNonce = randomBytes(32);
      const [challenge] = await control.command(`AUTHCHALLENGE SAFECOOKIE ${clientNonce.toString('hex')}`);
      const serverNonce = Buffer.from(challenge.match(/SERVERNONCE=([0-9A-F]+)/i)?.[1] ?? '', 'hex');
      const key = 'Tor safe cookie authentication controller-to-server hash';
      const hash = createHmac('sha256', key).update(Buffer.concat([cookie, clientNonce, serverNonce])).digest('hex');
      await control.command(`AUTHENTICATE ${hash}`);
    }
  } else {
    throw new TorError(`Tor's control port wants ${methods.join(', ') || 'an unknown method'}: set its password in the node's tor settings`);
  }
}

/**
 * Publishes a local port as a Tor onion service and keeps it up: the service lives as long
 * as the control connection, which is re-opened (with the same key, so the same address)
 * when Tor restarts.
 */
export class OnionService {
  address: string | null = null;
  private control: ControlConnection | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(private readonly options: OnionServiceOptions) {}

  /** Starts publishing; resolves with the .onion host name, or rejects on the first failure (it keeps retrying). */
  start(): Promise<string> {
    this.stopped = false;
    return this.connect();
  }

  private async connect(): Promise<string> {
    try {
      const control = await ControlConnection.open(parseSocksAddress(this.options.controlPort, 9051));
      this.control = control;
      await authenticate(control, this.options.password);
      const saved = this.options.loadKey();
      const port = `Port=${this.options.virtualPort},${this.options.target.host}:${this.options.target.port}`;
      const lines = await control.command(`ADD_ONION ${saved ?? 'NEW:ED25519-V3'} ${port}`);
      const serviceId = lines.find((line) => line.startsWith('ServiceID='))?.slice(10);
      const key = lines.find((line) => line.startsWith('PrivateKey='))?.slice(11);
      if (!serviceId) throw new TorError('Tor did not say which onion address it created');
      if (key && !saved) this.options.saveKey(key);
      this.address = `${serviceId}.onion`;
      this.options.onReady(this.address);
      void control.closed.then(() => {
        if (this.stopped) return;
        log.warn('The Tor control connection closed; publishing the onion service again shortly');
        this.schedule();
      });
      return this.address;
    } catch (error) {
      this.control?.close();
      this.control = null;
      if (!this.stopped) this.schedule();
      throw error;
    }
  }

  private schedule(): void {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect().catch((error) => log.warn(`Onion service: ${(error as Error).message}`));
    }, 30_000);
    this.retry.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.control?.close();
    this.control = null;
  }
}
