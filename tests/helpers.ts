import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from '../src/shared/crypto.js';
import { log } from '../src/shared/log.js';
import { NodeClient, type AuthMode } from '../src/shared/nodeclient.js';
import { ProviderNode, type ProviderConfig } from '../src/provider/node.js';
import type { DeepPartial } from '../src/commerce/node.js';

log.setLevel((process.env.VIBESHARE_LOG as 'debug') ?? 'error');

export const ADMIN = 'test-admin-token';

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'vibeshare-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function startProvider(overrides: DeepPartial<ProviderConfig> = {}, dataDir: string | null = null) {
  const node = new ProviderNode({
    dataDir,
    adminToken: ADMIN,
    overrides: { host: '127.0.0.1', port: 0, ...overrides } as DeepPartial<ProviderConfig>,
  });
  await node.start();
  return node;
}

export function clientFor(url: string, auth: AuthMode = 'pseudonym', identity = generateIdentity()) {
  return new NodeClient({ url, auth, identity });
}

export async function admin<T>(url: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url + path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'x-admin-token': ADMIN, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export function randomBytesOf(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >> 16;
  }
  return out;
}

import { AlgorithmNode, type AlgorithmConfig } from '../src/algorithm/node.js';

export async function startAlgorithm(overrides: DeepPartial<AlgorithmConfig> = {}, dataDir: string | null = null) {
  const node = new AlgorithmNode({
    dataDir,
    adminToken: ADMIN,
    overrides: { host: '127.0.0.1', port: 0, ...overrides } as DeepPartial<AlgorithmConfig>,
  });
  await node.start();
  return node;
}

import { ClientNode } from '../src/client/daemon.js';

export async function startClient(dataDir: string) {
  const client = new ClientNode({ dataDir, port: 0, serviceIntervalMs: 3600_000, refreshIntervalMs: 3600_000 });
  await client.start();
  const api = async <T>(path: string, init: { method?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}) => {
    const response = await fetch(client.url() + path, {
      method: init.method ?? (init.body || init.raw ? 'POST' : 'GET'),
      headers: { 'x-vs-token': client.token, 'content-type': init.raw ? 'application/octet-stream' : 'application/json', ...init.headers },
      body: init.raw ?? (init.body ? JSON.stringify(init.body) : undefined),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };
  return { client, api };
}

export async function waitFor<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 10000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
