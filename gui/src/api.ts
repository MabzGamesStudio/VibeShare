// Talks to the local client daemon. The daemon puts its access token in the page
// (<meta name="vs-token">); during development it can be passed as ?t=… instead.

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
  const response = await fetch(path, {
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
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
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
