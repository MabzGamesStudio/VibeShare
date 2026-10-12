// Calls to other nodes over HTTP(S) with fetch. Browser-safe.

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
  /** How to send it (default: fetch). Clients route requests through Tor this way. */
  transport?: Transport;
}

export interface Transport {
  fetch: typeof fetch;
  /** Multiplies timeouts (requests through Tor take longer). */
  timeoutFactor?: number;
}

export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  let body: Uint8Array<ArrayBuffer> | string | undefined;
  if (options.raw) {
    // (A copy on its own ArrayBuffer, which is what fetch's types ask for everywhere.)
    body = new Uint8Array(options.raw);
    headers['content-type'] ??= 'application/octet-stream';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  let response: Response;
  try {
    const send = options.transport?.fetch ?? fetch;
    response = await send(url, {
      method: options.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: AbortSignal.timeout((options.timeoutMs ?? 15000) * (options.transport?.timeoutFactor ?? 1)),
    });
  } catch (error) {
    const name = (error as Error).name;
    const cause = name === 'TimeoutError' ? ' timed out' : name === 'TorError' ? `: ${(error as Error).message}` : ` ${(error as Error).message}`;
    throw new RemoteError(0, 'unreachable', `${new URL(url).host}${cause}`);
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
