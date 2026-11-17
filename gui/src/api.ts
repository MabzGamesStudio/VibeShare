// Talks to the client backend: the local daemon (desktop app, `vibeshare client`), or —
// in the static web build — the in-browser backend served by the service worker.
// The daemon puts its access token in the page (<meta name="vs-token">); during
// development it can be passed as ?t=… instead.

import type { NodeEntry } from '../../src/shared/clientapi';
import { CLIENT_API, clientApiPath, type ClientApiRequest, type ClientApiResponse } from '../../src/shared/clientapi.generated';
import type { TraceSettings } from '../../src/shared/tracing';
import { APP_BASE } from './util';

/** True in the static web build (normal routes, backend in the browser). */
export const IS_STATIC = __VIBESHARE_WEB__;

type LocalHandler = (request: Request) => Promise<Response>;
let localHandler: LocalHandler | null = null;

/** Without a service worker, the static build answers API calls in the page itself. */
export function setLocalHandler(handler: LocalHandler | null): void {
  localHandler = handler;
}

/** API and stream paths: absolute for the daemon, relative to the app folder in the static build (the document's base is that folder). */
export function resolvePath(path: string): string {
  return IS_STATIC ? path.replace(/^\//, '') : path;
}

function send(path: string, init: RequestInit): Promise<Response> {
  const target = resolvePath(path);
  if (localHandler) return localHandler(new Request(new URL(target, APP_BASE), init));
  return fetch(target, init);
}

function readToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="vs-token"]')?.content;
  const fromUrl = new URLSearchParams(location.search).get('t');
  let stored = '';
  try {
    stored = sessionStorage.getItem('vs-token') ?? '';
  } catch {
    // storage unavailable
  }
  const token = meta || fromUrl || stored;
  try {
    if (token) sessionStorage.setItem('vs-token', token);
  } catch {
    // storage unavailable
  }
  return token;
}

/**
 * The daemon's local API token, read per call rather than once at module load: the meta
 * tag can appear after this module first runs, and a restarted daemon rotates its token —
 * a cached one would lock the GUI out of its own backend until a full reload. When there
 * is no token, no header is sent at all: an empty `x-vs-token` would outrank the daemon's
 * own cookie on the server side and turn every call into a 403.
 */
function authHeaders(): Record<string, string> {
  const token = readToken();
  return token ? { 'x-vs-token': token } : {};
}

// ---------------------------------------------------------------------------
// User-action tracing (Settings → Logging → Trace logs)
//
// While the user has trace logs on with the detailed level, every click and change
// starts one timeline in the daemon's trace log: a detail event posted to
// /api/tracing/events carries the fresh trace id, and the API calls that follow send
// it as `x-vs-trace` so the daemon's request timeline joins the same one. Off by
// default — with the setting off nothing is posted and no header is sent.

/** How long a user-action trace id keeps tagging the API calls that follow it. */
const ACTION_TRACE_MS = 30_000;

let traceDetail = false;
let actionTrace: { id: string; until: number } | null = null;

/** Kept fresh from the client settings (state.tsx); off turns the whole feature quiet. */
export function setTraceSettings(settings: TraceSettings | null): void {
  traceDetail = Boolean(settings?.enabled && settings?.levels.detail);
  if (!traceDetail) actionTrace = null;
}

/** Whether user actions are being traced right now (guard before any label building). */
export function userActionsTraced(): boolean {
  return traceDetail;
}

/** The trace id of the last user action, until its short expiry lapses. */
function currentActionTrace(): string | undefined {
  if (!traceDetail || !actionTrace) return undefined;
  if (Date.now() > actionTrace.until) {
    actionTrace = null;
    return undefined;
  }
  return actionTrace.id;
}

function startAction(label: string): void {
  if (!traceDetail) return;
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  actionTrace = { id, until: Date.now() + ACTION_TRACE_MS };
  // Fire and forget, and never through api(): a trace line neither fails what the user
  // was doing nor starts a timeline of its own for its own logging.
  send('/api/tracing/events', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'detail', component: 'gui', action: label, traceId: id, initiator: { kind: 'user-action', label } }),
  }).catch(() => undefined);
}

/** One user action (a button, a link): its own timeline, which the next calls join. */
export function traceAction(label: string): void {
  startAction(label);
}

/** One change (a field, a toggle): recorded and followed exactly the same way. */
export function traceChange(label: string): void {
  startAction(label);
}

/**
 * Calls the listener with the node list (status and credits) whenever it changes in the
 * client backend: Server-Sent Events from the daemon, messages from the web client's
 * service worker or in-page backend. Nothing here asks the nodes anything.
 */
export function onNodesChanged(listener: (nodes: NodeEntry[]) => void): () => void {
  if (IS_STATIC) {
    const fromPage = (event: Event) => listener((event as CustomEvent<NodeEntry[]>).detail);
    const fromWorker = (event: MessageEvent) => {
      if (event.data?.type === 'vs-nodes') listener(event.data.nodes as NodeEntry[]);
    };
    window.addEventListener('vs-nodes', fromPage);
    navigator.serviceWorker?.addEventListener('message', fromWorker);
    return () => {
      window.removeEventListener('vs-nodes', fromPage);
      navigator.serviceWorker?.removeEventListener('message', fromWorker);
    };
  }
  // (EventSource cannot send headers; the daemon also takes its token as ?t=.)
  const events = new EventSource(`/api/events?t=${encodeURIComponent(readToken())}`);
  events.addEventListener('nodes', (event) => listener(JSON.parse((event as MessageEvent<string>).data) as NodeEntry[]));
  return () => events.close();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const trace = currentActionTrace();
  const response = await send(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    // The user action's trace id (when one is current) joins this call to its timeline.
    headers: { ...authHeaders(), ...(trace ? { 'x-vs-trace': trace } : {}), 'content-type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } })?.error;
    throw new ApiError(response.status, error?.code ?? 'error', error?.message ?? response.statusText, parsed);
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// A handful of calls through the generated typed route map
// (src/shared/clientapi.generated.ts): their paths and response types come straight
// from the route table, so a route that changes is a compile error here rather than a
// broken call. Exactly the same requests as calling api() with a literal path — the
// rest of the GUI migrates to these gradually.
/** GET /api/version — the contract version of the local API. */
export function getApiVersion(): Promise<ClientApiResponse<'get-version'>> {
  return api(CLIENT_API['get-version'].path);
}

/** GET /api/state — everything the GUI renders from. */
export function getClientState(): Promise<ClientApiResponse<'get-state'>> {
  return api(CLIENT_API['get-state'].path);
}

/** PATCH /api/settings — a partial settings update. */
export function patchSettings(body: ClientApiRequest<'patch-settings'>): Promise<ClientApiResponse<'patch-settings'>> {
  return api(CLIENT_API['patch-settings'].path, { method: 'PATCH', body });
}

/** GET /api/jobs — the publish jobs of this device. */
export function getJobs(): Promise<ClientApiResponse<'get-jobs'>> {
  return api(CLIENT_API['get-jobs'].path);
}

/** GET /api/jobs/:id — one publish job. */
export function getJob(id: string): Promise<ClientApiResponse<'get-jobs-id'>> {
  return api(clientApiPath('get-jobs-id', { id }));
}

/** GET /api/saved — the saved cids and their collections. */
export function getSaved(): Promise<ClientApiResponse<'get-saved'>> {
  return api(CLIENT_API['get-saved'].path);
}

/** GET /api/toasts — the saved toast messages (optionally searched). */
export function getToasts(query?: string): Promise<ClientApiResponse<'get-toasts'>> {
  return api(query ? `${CLIENT_API['get-toasts'].path}?q=${encodeURIComponent(query)}` : CLIENT_API['get-toasts'].path);
}

/** Uploads a file to the daemon with progress (fetch cannot report upload progress). */
export function uploadFile(file: File, onProgress: (fraction: number) => void): Promise<{ fileId: string; size: number }> {
  if (localHandler) {
    return send('/api/upload', { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } }).then(async (response) => {
      onProgress(1);
      if (!response.ok) throw new ApiError(response.status, 'upload_failed', await response.text());
      return response.json();
    });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', resolvePath('/api/upload'));
    const auth = authHeaders();
    if (auth['x-vs-token']) xhr.setRequestHeader('x-vs-token', auth['x-vs-token']);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new ApiError(xhr.status, 'upload_failed', xhr.responseText || 'Upload failed'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Upload failed'));
    xhr.send(file);
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return (error as Error)?.message ?? String(error);
}

type StreamResolver = (src: string) => Promise<string>;
let streamResolver: StreamResolver | null = null;

/** When the web client's backend runs in the page, media elements get blob URLs instead. */
export function setStreamResolver(resolver: StreamResolver | null): void {
  streamResolver = resolver;
}

/** Whether a media URL must be turned into a blob URL first (see setStreamResolver). */
export function needsResolving(src: string): boolean {
  return streamResolver !== null && /^stream\//.test(src);
}

export function resolveStream(src: string): Promise<string> {
  return streamResolver ? streamResolver(src) : Promise.resolve(src);
}

/** URL that streams (or downloads) native content through the client backend. */
export function streamUrl(base: string, download = false): string {
  const query = [download ? 'download=1' : '', IS_STATIC ? '' : `t=${readToken()}`].filter(Boolean).join('&');
  return `${resolvePath(`/stream/${base}`)}${query ? `?${query}` : ''}`;
}
