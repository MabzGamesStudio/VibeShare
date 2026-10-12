// Talks to the client backend: the local daemon (desktop app, `vibeshare client`), or —
// in the static web build — the in-browser backend served by the service worker.
// The daemon puts its access token in the page (<meta name="vs-token">); during
// development it can be passed as ?t=… instead.

/** True in the static web build (hash router, backend in the browser). */
export const IS_STATIC = __VIBESHARE_WEB__;

type LocalHandler = (request: Request) => Promise<Response>;
let localHandler: LocalHandler | null = null;

/** Without a service worker, the static build answers API calls in the page itself. */
export function setLocalHandler(handler: LocalHandler | null): void {
  localHandler = handler;
}

/** API and stream paths: absolute for the daemon, relative to the page in the static build. */
export function resolvePath(path: string): string {
  return IS_STATIC ? path.replace(/^\//, '') : path;
}

function send(path: string, init: RequestInit): Promise<Response> {
  const target = resolvePath(path);
  if (localHandler) return localHandler(new Request(new URL(target, document.baseURI), init));
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

export const token = readToken();

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
  const response = await send(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { 'x-vs-token': token, 'content-type': 'application/json' },
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
    xhr.setRequestHeader('x-vs-token', token);
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
  const query = [download ? 'download=1' : '', IS_STATIC ? '' : `t=${token}`].filter(Boolean).join('&');
  return `${resolvePath(`/stream/${base}`)}${query ? `?${query}` : ''}`;
}
