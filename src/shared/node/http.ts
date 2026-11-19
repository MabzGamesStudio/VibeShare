import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { badRequest, HttpError, notFound } from '../errors.js';
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
  return Buffer.concat(pieces);
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
      // What the trace event about this request says once it ends: the label (the URL),
      // how long it took and which status the response carries.
      const info = (status: number): TraceRequestInfo => ({
        label,
        method: req.method ?? 'GET',
        path: url.pathname,
        ms: Date.now() - started,
        status,
      });
      try {
        const result = await (traceId ? runWithTrace(traceId, () => found.handler(ctx)) : found.handler(ctx));
        if (traceId) options.trace?.done(traceId, info(res.headersSent ? res.statusCode : result !== undefined ? 200 : 204));
        if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
        else if (!res.writableEnded && !res.headersSent) res.writeHead(204).end();
      } catch (error) {
        if (traceId) options.trace?.failed(traceId, info(error instanceof HttpError ? error.status : 500), error);
        throw error;
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message, ...error.extra } });
      } else {
        if (!options.quietFailures) log.error(`[${options.name}] ${req.method} ${url.pathname} failed:`, error);
        sendJson(res, 500, { error: { code: 'internal', message: (error as Error)?.message ?? 'Internal error' } });
      }
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
