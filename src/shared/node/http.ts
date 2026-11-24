import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { badRequest, HttpError, notFound } from '../errors.js';
import { payloadPrefix } from '../tracing.js';
import { log } from './log.js';
import { runWithTrace } from './tracecontext.js';

export * from '../errors.js';
export * from '../remote.js';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  ip: string;
}

/** Return a value to send it as JSON; return undefined after writing the response yourself. */
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  /** The path as registered, kept for the manifest (docs and tests read it). */
  path: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, path, parts: path.split('/').filter(Boolean), handler });
    return this;
  }

  /** Every route this server registered, as `{ method, path }` — the same shape the
   * shared route tables produce, so a node can be checked against the protocol docs. */
  manifest(): { method: string; path: string }[] {
    return this.routes.map((route) => ({ method: route.method, path: route.path }));
  }
  get(path: string, handler: Handler) {
    return this.on('GET', path, handler);
  }
  post(path: string, handler: Handler) {
    return this.on('POST', path, handler);
  }
  put(path: string, handler: Handler) {
    return this.on('PUT', path, handler);
  }
  patch(path: string, handler: Handler) {
    return this.on('PATCH', path, handler);
  }
  delete(path: string, handler: Handler) {
    return this.on('DELETE', path, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const pattern = route.parts[i];
        if (pattern === '*') {
          params['*'] = parts.slice(i).map(decodeURIComponent).join('/');
          i = route.parts.length;
          break;
        }
        const part = parts[i];
        if (part === undefined) {
          ok = false;
          break;
        }
        if (pattern.startsWith(':')) {
          try {
            params[pattern.slice(1)] = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
        } else if (pattern !== part) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.parts[route.parts.length - 1] !== '*' && parts.length !== route.parts.length) continue;
      return { handler: route.handler, params };
    }
    return null;
  }
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'too_large', `Body larger than ${limit} bytes`);
  const pieces: Buffer[] = [];
  let size = 0;
  for await (const piece of req) {
    size += piece.length;
    if (size > limit) throw new HttpError(413, 'too_large', `Body larger than ${limit} bytes`);
    pieces.push(piece);
  }
  const body = Buffer.concat(pieces);
  // Detail-mode tracing keeps the first payloadChars characters of the body (already
  // read for the handler — tracing adds no extra buffering).
  payloadSlots.get(req)?.request?.takeBytes(body);
  return body;
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage, limit = 1024 * 1024): Promise<T> {
  const body = await readBody(req, limit);
  if (body.length === 0) return {} as T;
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw badRequest('Body is not valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/**
 * Cache headers for a read whose bytes are addressed by `id`. Content ids and chunk
 * ids hash the exact bytes — the same id is always the same bytes — so the strong
 * ETag is honest and caches may keep the answer forever. `weak` is for keys that only
 * name a slot (a thumbnail can be re-uploaded under its key): a hint of sameness
 * rather than a promise of byte-exactness.
 */
export function immutableHeaders(id: string, options: { scope?: 'public' | 'private'; weak?: boolean } = {}): Record<string, string> {
  return {
    etag: `${options.weak ? 'W/' : ''}"${id}"`,
    // 'private' keeps paid or account-scoped bytes out of shared caches — the id is
    // immutable either way, only who may hold a copy changes.
    'cache-control': `${options.scope === 'private' ? 'private' : 'public'}, max-age=31536000, immutable`,
  };
}

/**
 * Answers 304 (no body) when the client already holds this exact id, instead of
 * sending — and charging for — bytes it did not receive. Both ETag spellings match
 * (RFC 9110 compares If-None-Match weakly), so a cautious client sending W/"<id>"
 * for a strong tag still gets its 304.
 */
export function notModified(ctx: Ctx, id: string, options: { weak?: boolean } = {}): boolean {
  const header = ctx.req.headers['if-none-match'];
  const tag = `${options.weak ? 'W/' : ''}"${id}"`;
  const strong = `"${id}"`;
  const match = String(Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => part.trim())
    .some((part) => part === '*' || part === tag || part === `W/${strong}` || part === strong);
  if (!match) return false;
  ctx.res.writeHead(304, { etag: tag }).end();
  return true;
}

export function clientIp(req: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export interface ServeOptions {
  router: Router;
  /** Allow browsers on any origin (public nodes). */
  cors?: boolean;
  trustProxy?: boolean;
  name: string;
  /** Headers every reply of this server carries (e.g. the local API's version marker). */
  responseHeaders?: Record<string, string>;
  /** Called when no route matches (static files, …). Return false for a 404. */
  fallback?: (ctx: Ctx) => Promise<boolean> | boolean;
  /** Runs before routing; throw an HttpError to reject the request. */
  guard?: (ctx: Ctx) => void;
  /**
   * Keeps unexpected request failures out of the console (the demo sets this: it prints
   * its own script, and a node that does not have an object is a normal answer there).
   * The 500 reply itself is unchanged.
   */
  quietFailures?: boolean;
  /**
   * Local tracing of every API request (off by default downstream): one timeline per
   * call, told how it ended so the trace line carries the URL and response time.
   */
  trace?: {
    request: (label: string, body: unknown) => string;
    done: (traceId: string, info: TraceRequestInfo) => void;
    failed: (traceId: string, info: TraceRequestInfo, error: unknown) => void;
    /**
     * What to capture of the request/response payloads for the trace event: the
     * settings' payloadChars while detail-level tracing is on, false otherwise. Asked
     * per traced request — while it says no, nothing is captured and nothing extra is
     * buffered. (The level check lives with the caller, whose trace settings it is.)
     */
    payloadChars?: () => number | false;
  };
}

/** How one traced request ended — what the trace event about it should say. */
export interface TraceRequestInfo {
  /** "METHOD /path", the same label the request hook was given. */
  label: string;
  method: string;
  path: string;
  /** How long the whole request took, in milliseconds. */
  ms: number;
  /** The status the response carried (the error's status when the request failed). */
  status: number;
  /** Detail mode: the first payloadChars characters of the request body, redacted. */
  requestPayload?: string;
  /** Detail mode: the first payloadChars characters of the JSON/text response, redacted. */
  responsePayload?: string;
}

// ---------------------------------------------------------------------------
// Payload capture for detail-mode tracing
//
// One slot per traced request: the body readers and the response wrapper below fill
// it with the first payloadChars characters (redacted by payloadPrefix) and the trace
// line reads it when the call ends. Nothing is captured — and nothing extra is
// buffered — while the caller's settings say no. Streaming, range and binary
// responses are never touched: their bytes pass through unwrapped-and-unread.

class TextPrefix {
  private text = '';
  private more = false;
  constructor(private readonly limit: number) {}

  /** Takes a text chunk; once the limit is reached it only remembers there was more. */
  take(chunk: string | Uint8Array): void {
    if (this.more) return;
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (this.text.length >= this.limit) {
      this.more = true;
      return;
    }
    this.text += text;
    if (this.text.length > this.limit) this.more = true;
  }

  /** Takes the head of a body the handler already read — the rest is never converted. */
  takeBytes(body: Buffer): void {
    this.take(body.subarray(0, this.limit * 4 + 256));
  }

  /** The redacted prefix to put on the trace event (undefined when nothing arrived). */
  value(): string | undefined {
    if (!this.text && !this.more) return undefined;
    return payloadPrefix(`${this.text}${this.more ? '…' : ''}`, this.limit);
  }
}

interface PayloadCapture {
  /** Undefined when the request body is binary (uploads are never textified). */
  request?: TextPrefix;
  response: TextPrefix;
  result(): { requestPayload?: string; responsePayload?: string };
}

const payloadSlots = new WeakMap<IncomingMessage, PayloadCapture>();

/**
 * Opens the payload capture of one traced request: the request side (text-ish bodies
 * only) and the response side (JSON/text bodies of ordinary replies only — streamed,
 * range and event-stream answers are skipped entirely, so they cannot be broken or
 * buffered by tracing).
 */
function openPayloadCapture(req: IncomingMessage, res: ServerResponse, limit: number): PayloadCapture | undefined {
  if (!(limit > 0)) return undefined;
  const requestType = String(req.headers['content-type'] ?? '');
  const capture: PayloadCapture = {
    request: /json|text\/|x-www-form-urlencoded/i.test(requestType) ? new TextPrefix(limit) : undefined,
    response: new TextPrefix(limit),
    result() {
      return { requestPayload: capture.request?.value(), responsePayload: capture.response.value() };
    },
  };
  payloadSlots.set(req, capture);
  let eligible: boolean | undefined;
  // Headers vanish from getHeader() once writeHead() flushes them — so remember the
  // ones it was given; res.setHeader()-style replies are still readable at take time.
  let headType = '';
  let headRange = false;
  const take = (chunk: unknown) => {
    if (eligible === undefined) {
      const type = headType || String(res.getHeader('content-type') ?? '');
      const streamed = /event-stream/i.test(type) || headRange || res.getHeader('content-range') !== undefined || req.headers.range !== undefined;
      eligible = !streamed && /json|^text\//i.test(type);
    }
    if (eligible && (typeof chunk === 'string' || chunk instanceof Uint8Array)) capture.response.take(chunk);
  };
  // The wrappers pass every byte through untouched; they only watch what flows.
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((status?: unknown, ...rest: unknown[]) => {
    const headers = (typeof rest[0] === 'string' ? rest[1] : rest[0]) as Record<string, unknown> | undefined;
    if (headers && typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === 'content-type') headType = String(value);
        if (name.toLowerCase() === 'content-range') headRange = true;
      }
    }
    return (writeHead as (...args: unknown[]) => ServerResponse)(status, ...rest);
  }) as typeof res.writeHead;
  res.write = ((chunk?: unknown, ...rest: unknown[]) => {
    take(chunk);
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (chunk !== undefined && typeof chunk !== 'function') take(chunk);
    return (end as (...args: unknown[]) => ServerResponse)(chunk, ...rest);
  }) as typeof res.end;
  return capture;
}

export function createHttpServer(options: ServeOptions): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: Ctx = { req, res, url, params: {}, query: url.searchParams, ip: clientIp(req, options.trustProxy) };
    // Set before any routing or error handling, so every reply carries them — whatever
    // path the response takes out (JSON, raw bytes, an error, a hand-written reply).
    if (options.responseHeaders) for (const [name, value] of Object.entries(options.responseHeaders)) res.setHeader(name, value);
    if (options.cors) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-expose-headers', 'x-vs-charged, x-vs-balance, content-range, accept-ranges');
    }
    if (req.method === 'OPTIONS') {
      if (options.cors) {
        res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE');
        res.setHeader('access-control-allow-headers', 'authorization, content-type, range');
        res.setHeader('access-control-max-age', '86400');
      }
      res.writeHead(204).end();
      return;
    }
    // The trace line of a traced request, recorded after its reply is written —
    // whatever came out (JSON, a hand-written reply, an error body) is captured by
    // then, and one failure records exactly one line.
    let traced: { traceId: string; info: (status: number) => TraceRequestInfo } | undefined;
    try {
      options.guard?.(ctx);
      const found = options.router.match(req.method ?? 'GET', url.pathname);
      if (!found) {
        if (options.fallback && (await options.fallback(ctx))) return;
        throw notFound(`No route for ${req.method} ${url.pathname}`);
      }
      ctx.params = found.params;
      const label = `${req.method} ${url.pathname}`;
      const traceId = options.trace?.request(label, undefined);
      const started = Date.now();
      // Detail-mode payload capture: open only for traced requests and only while the
      // caller's own settings ask for payloads (off = nothing captured or buffered).
      const capture = traceId ? openPayloadCapture(req, res, options.trace?.payloadChars?.() || 0) : undefined;
      // What the trace event about this request says once it ends: the label (the URL),
      // how long it took, which status the response carries and the payload prefixes.
      const info = (status: number): TraceRequestInfo => ({
        label,
        method: req.method ?? 'GET',
        path: url.pathname,
        ms: Date.now() - started,
        status,
        ...(capture?.result() ?? {}),
      });
      if (traceId) traced = { traceId, info };
      const result = await (traceId ? runWithTrace(traceId, () => found.handler(ctx)) : found.handler(ctx));
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
      else if (!res.writableEnded && !res.headersSent) res.writeHead(204).end();
      if (traced) options.trace?.done(traced.traceId, traced.info(res.statusCode));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (res.headersSent) {
        // The handler wrote a reply and then failed: record what was captured.
        if (traced) options.trace?.failed(traced.traceId, traced.info(status), error);
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message, ...error.extra } });
      } else {
        if (!options.quietFailures) log.error(`[${options.name}] ${req.method} ${url.pathname} failed:`, error);
        sendJson(res, 500, { error: { code: 'internal', message: (error as Error)?.message ?? 'Internal error' } });
      }
      // After the error reply is written, so its payload prefix is captured too.
      if (traced) options.trace?.failed(traced.traceId, traced.info(status), error);
    }
  });
}

export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

// ---------------------------------------------------------------------------
// Outgoing requests to other nodes
