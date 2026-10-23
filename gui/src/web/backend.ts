// The web client's backend: the same client core and API as the desktop daemon,
// answering the GUI's requests inside the browser (in a service worker, or in the page
// when service workers are unavailable). Node calls go straight to the user's nodes.
import { clientRoutes, type ApiRequest, type ApiRoute } from '../../../src/client/api';
import { ClientCore } from '../../../src/client/core';
import { FetchError } from '../../../src/client/fetcher';
import type { ServiceStatus } from '../../../src/shared/clientapi';
import { MiB } from '../../../src/shared/content';
import { fromBase64url } from '../../../src/shared/encoding';
import { badRequest, HttpError } from '../../../src/shared/errors';
import { parseNodeRefs } from '../../../src/shared/noderef';
import { SOFTWARE } from '../../../src/shared/protocol';
import { parseContentId } from '../../../src/shared/sources';
import { MemoryUploads, WebChunkCache, WebStore, type KeyValue } from './store';

/** config.json next to the web client: what a hosted copy starts with. */
export interface WebConfig {
  /** Where shared links point (defaults to where the web client is hosted). */
  shareBaseUrl?: string;
  /** Node references added the first time someone opens the client. */
  defaultNodes?: string[];
}

export interface Backend {
  core: ClientCore;
  store: WebStore;
  /** Answers a request for `path` (/api/… or /stream/…, relative to where the client is hosted). */
  handle(request: Request, path: string): Promise<Response>;
  /** Resolves when changes are saved and running publications have ended. */
  idle(): Promise<void>;
}

export interface BackendOptions {
  kv: KeyValue;
  config: WebConfig;
  /** URL of the web client itself. */
  appUrl: string;
  /** Host name of the page (embedded players need it). */
  hostName: string;
}

const UNAVAILABLE_SERVICE: ServiceStatus & { unavailable: string } = {
  enabled: false,
  quotaBytes: 0,
  usedBytes: 0,
  providers: [],
  log: [],
  unavailable: 'Storing data for providers needs a client that keeps running: the desktop app or `vibeshare client`.',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json(error.status, { error: { code: error.code, message: error.message, ...error.extra } });
  console.error(error);
  return json(500, { error: { code: 'internal', message: (error as Error)?.message ?? 'Internal error' } });
}

/** A pull-based stream: the next chunk is fetched only when the player wants more. */
function toStream(body: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await body.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await body.return(undefined);
    },
  });
}

interface Compiled {
  route: ApiRoute;
  parts: string[];
}

function match(routes: Compiled[], method: string, path: string): { route: ApiRoute; params: Record<string, string> } | null {
  const parts = path.split('/').filter(Boolean);
  for (const { route, parts: pattern } of routes) {
    if (route.method !== method || pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length && ok; i++) {
      if (pattern[i].startsWith(':')) {
        try {
          params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
        }
      } else ok = pattern[i] === parts[i];
    }
    if (ok) return { route, params };
  }
  return null;
}

/**
 * Browsers only let an https page call nodes over https (or on this computer): say so
 * instead of the browser's bare "Failed to fetch".
 */
function insecureNodes(text: string, appUrl: string): string[] {
  if (!appUrl.startsWith('https:')) return [];
  return parseNodeRefs(text).refs.filter((ref) => ref.url.startsWith('http:') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(ref.url)).map((ref) => ref.url);
}

export async function createBackend(options: BackendOptions): Promise<Backend> {
  const store = await WebStore.open(options.kv);
  const cache = await WebChunkCache.open(options.kv, () => store.data.data.settings.cacheMiB * MiB);
  const uploads = new MemoryUploads();
  const core = new ClientCore({
    store,
    cache,
    uploads,
    version: `${SOFTWARE} (web)`,
    thumbnailUrl: (node, key) => `${node.url}/v1/thumbnails/${encodeURIComponent(key)}`,
    streamUrl: (base, download) => `stream/${base}${download ? '?download=1' : ''}`,
    embedHost: () => options.hostName,
  });

  if (store.fresh) {
    // The first visit: links point to where this client is hosted unless the host says otherwise.
    const base = options.config.shareBaseUrl || options.appUrl.replace(/\/+$/, '');
    try {
      core.updateSettings({ shareBaseUrl: base });
    } catch {
      // keep the default
    }
    await core.addDefaultNodes((options.config.defaultNodes ?? []).filter((ref) => typeof ref === 'string'));
    store.changed();
    await store.saved();
  }
  // No checking of nodes on start or on a timer: status and balances come from real use.

  const routes: Compiled[] = clientRoutes(core).map((route) => ({ route, parts: route.path.split('/').filter(Boolean) }));

  async function stream(request: Request, id: string, url: URL): Promise<Response> {
    // A .vvsh stream as byte ranges: the browser's own seeking drives it, and only the
    // chunks that hold the asked-for bytes are fetched from the provider.
    if (id.startsWith('vvsh.')) {
      const spec = JSON.parse(new TextDecoder().decode(fromBase64url(id.slice(5)))) as { n: string; r: string; c: number; q: string; d: number };
      const total = spec.d;
      const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '');
      const start = range && range[1] ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]) + 1, total) : total;
      const bytes = await core.vvshStreamRange(spec, start, end);
      const headers: Record<string, string> = {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-length': String(bytes.length),
      };
      const status = range ? 206 : 200;
      if (range) headers['content-range'] = `bytes ${start}-${start + bytes.length - 1}/${total}`;
      return new Response(request.method === 'HEAD' ? null : (bytes.slice().buffer as ArrayBuffer), { status, headers });
    }
    const parsed = parseContentId(id);
    if (!parsed?.native) throw badRequest('Only native content (vs1…) can be streamed from providers');
    try {
      const answer = await core.fetcher.open(parsed.base, request.headers.get('range'), url.searchParams.get('download') === '1');
      if (request.method === 'HEAD' && answer.body) await answer.body.return(undefined);
      const body = request.method === 'HEAD' || !answer.body ? null : toStream(answer.body);
      return new Response(body, { status: answer.status, headers: answer.headers });
    } catch (error) {
      if (error instanceof FetchError) throw new HttpError(502, 'unavailable', error.message, { attempts: error.attempts });
      throw error;
    }
  }

  async function handle(request: Request, path: string): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    try {
      if (path.startsWith('/stream/') && method === 'GET') return await stream(request, decodeURIComponent(path.slice(8)), url);
      if (path === '/api/upload' && method === 'POST') return json(200, uploads.putBlob(await request.blob()));
      if (path === '/api/services' && method === 'GET') return json(200, UNAVAILABLE_SERVICE);
      if (path === '/api/services/sync' && method === 'POST') return json(200, UNAVAILABLE_SERVICE);
      if (path === '/api/nodes' && method === 'POST') {
        const text = String(((await request.clone().json().catch(() => ({}))) as { text?: string }).text ?? '');
        const insecure = insecureNodes(text, options.appUrl);
        if (insecure.length) {
          throw badRequest(`This page is served over https, so browsers only let it reach nodes over https (${insecure.join(', ')} is http).`);
        }
      }
      const found = match(routes, method, path);
      if (!found) throw new HttpError(404, 'not_found', `No route for ${request.method} ${path}`);
      const apiRequest: ApiRequest = {
        params: found.params,
        query: url.searchParams,
        async json<T>(limit = MiB): Promise<T> {
          const text = await request.text();
          if (text.length > limit) throw new HttpError(413, 'too_large', `Body larger than ${limit} bytes`);
          if (!text) return {} as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            throw badRequest('Body is not valid JSON');
          }
        },
      };
      const result = await found.route.handler(apiRequest);
      return result === undefined ? new Response(null, { status: 204 }) : json(200, result);
    } catch (error) {
      return errorResponse(error);
    }
  }

  return {
    core,
    store,
    handle,
    async idle() {
      await Promise.all([store.saved(), ...core.publisher.running.values()]);
    },
  };
}
