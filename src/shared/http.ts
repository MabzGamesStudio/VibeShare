import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from './log.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message: string) => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const paymentRequired = (message: string, extra?: Record<string, unknown>) =>
  new HttpError(402, 'payment_required', message, extra);

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
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
    return this;
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
  /** Called when no route matches (static files, …). Return false for a 404. */
  fallback?: (ctx: Ctx) => Promise<boolean> | boolean;
  /** Runs before routing; throw an HttpError to reject the request. */
  guard?: (ctx: Ctx) => void;
}

export function createHttpServer(options: ServeOptions): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: Ctx = { req, res, url, params: {}, query: url.searchParams, ip: clientIp(req, options.trustProxy) };
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
      const result = await found.handler(ctx);
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
      else if (!res.writableEnded && !res.headersSent) res.writeHead(204).end();
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message, ...error.extra } });
      } else {
        log.error(`[${options.name}] ${req.method} ${url.pathname} failed:`, error);
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

export class RemoteError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  raw?: Buffer | Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  let body: Buffer | Uint8Array | string | undefined;
  if (options.raw) {
    body = options.raw;
    headers['content-type'] ??= 'application/octet-stream';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });
  } catch (error) {
    const cause = (error as Error).name === 'TimeoutError' ? 'timed out' : (error as Error).message;
    throw new RemoteError(0, 'unreachable', `${new URL(url).host} ${cause}`);
  }
  if (!response.ok) {
    let parsed: unknown;
    let message = `${response.status} ${response.statusText}`;
    let code = `http_${response.status}`;
    try {
      parsed = await response.json();
      const error = (parsed as { error?: { code?: string; message?: string } }).error;
      if (error?.message) message = error.message;
      if (error?.code) code = error.code;
    } catch {
      // not JSON
    }
    throw new RemoteError(response.status, code, message, parsed);
  }
  return response;
}

export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(url, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
