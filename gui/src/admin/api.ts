// The dashboard runs on the node itself (same origin) and authenticates with the admin token.

const KEY = 'vibeshare-admin-token';

export function loadToken(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token: string): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the token lasts for this page only
  }
}

let current = loadToken();

export function setToken(token: string): void {
  current = token;
  saveToken(token);
}

export async function admin<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { 'x-admin-token': current, 'content-type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(parsed?.error?.message ?? `${response.status} ${response.statusText}`);
  return parsed as T;
}

export function message(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}
