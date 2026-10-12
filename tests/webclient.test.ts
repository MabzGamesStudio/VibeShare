// The web client's backend (gui/src/web), run in Node against real nodes: the same
// code the service worker runs, with an in-memory store instead of IndexedDB.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { ClientState, ContentView, FeedResponse, Job, Settings } from '../src/shared/clientapi.js';
import { MiB } from '../src/shared/content.js';
import { generateIdentity } from '../src/shared/crypto.js';
import { admin, randomBytesOf, startAlgorithm, startProvider, waitFor } from './helpers.js';

// Loaded at run time: these are browser modules, typechecked with the GUI project.
const web = (file: string) => import(pathToFileURL(resolve(import.meta.dirname, '../gui/src/web', file)).href);

interface Backend {
  handle(request: Request, path: string): Promise<Response>;
  idle(): Promise<void>;
}
type CreateBackend = (options: { kv: unknown; config: unknown; appUrl: string; hostName: string }) => Promise<Backend>;

describe('the web client backend', async () => {
  const provider = await startProvider({ name: 'Web CDN', signup: { grant: 50 }, pricing: { perMiB: 1, freeMiBPerDay: 0 } });
  const algorithm = await startAlgorithm({ name: 'Web Curator' });
  after(async () => {
    await provider.stop();
    await algorithm.stop();
  });
  const { createBackend } = (await web('backend.ts')) as { createBackend: CreateBackend };
  const { memoryKeyValue } = (await web('store.ts')) as { memoryKeyValue: () => unknown };
  const kv = memoryKeyValue();
  const offline = `vs:algorithm:${generateIdentity().id}@http://127.0.0.1:9`;
  const config = {
    shareBaseUrl: 'https://example.org/vibeshare',
    defaultNodes: [provider.reference(), algorithm.reference(), offline, 'vs:provider:REPLACE-WITH-YOUR-KEY@https://provider.example.org'],
  };
  const appUrl = 'http://127.0.0.1:8090/WebPages/VibeShare/';
  let backend = await createBackend({ kv, config, appUrl, hostName: '127.0.0.1' });

  const call = async (path: string, init: RequestInit = {}, using = backend) => {
    const response = await using.handle(new Request(new URL(path.slice(1), appUrl), init), path);
    await using.idle();
    return response;
  };
  const api = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
    const response = await call(path, {
      method: method ?? (body !== undefined ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text}`);
    return JSON.parse(text) as T;
  };

  it('starts with the nodes and share address of config.json', async () => {
    const state = await api<ClientState>('/api/state');
    assert.match(state.identity.id, /^vk1/);
    assert.match(state.version, /\(web\)$/);
    assert.deepEqual(
      state.nodes.map((node) => [node.type, node.name, node.status.online]),
      [
        ['provider', 'Web CDN', true],
        ['algorithm', 'Web Curator', true],
        ['algorithm', '127.0.0.1:9', false],
      ]
    );
    assert.equal(state.settings.shareBaseUrl, 'https://example.org/vibeshare');
    // Pseudonymous accounts were opened on the nodes that answered.
    assert.equal(state.nodes[0].balance, 50);
  });

  const video = randomBytesOf(Math.floor(2.5 * MiB), 3);
  let id = '';

  it('publishes a file held in browser memory', async () => {
    const upload = await call('/api/upload', { method: 'POST', body: new Blob([video]) });
    const { fileId, size } = (await upload.json()) as { fileId: string; size: number };
    assert.equal(size, video.length);
    const job = await api<Job>('/api/publish', {
      fileId,
      name: 'clip.webm',
      mime: 'video/webm',
      title: 'Made in a browser',
      format: 'short-video',
      rating: 'all',
      providers: [provider.identity.id],
      algorithms: [algorithm.identity.id],
      sign: true,
    });
    const done = await waitFor(async () => {
      const current = await api<Job>(`/api/jobs/${job.id}`);
      return current.status !== 'running' && current;
    });
    assert.equal(done.status, 'done', JSON.stringify(done.steps));
    id = done.result!.id;
    const pending = await admin<{ submissions: { id: string }[] }>(algorithm.url(), '/v1/admin/submissions');
    await admin(algorithm.url(), `/v1/admin/submissions/${pending.submissions[0].id}/accept`, { body: {} });
    const shorts = await api<FeedResponse>('/api/browse', { source: 'feed', filters: { formats: ['short-video'] } });
    assert.deepEqual(shorts.items.map((item) => item.title), ['Made in a browser']);
  });

  it('streams native content with range requests, verified chunk by chunk', async () => {
    const view = await api<ContentView>(`/api/content/${encodeURIComponent(id)}`);
    assert.equal(view.status, 'listed');
    assert.equal(view.streamUrl, `stream/${view.base}`);
    const whole = await call(`/stream/${view.base}`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/webm');
    assert.ok(Buffer.from(await whole.arrayBuffer()).equals(video));
    // A seek into the middle, across a chunk boundary.
    const start = MiB - 100;
    const part = await call(`/stream/${view.base}`, { headers: { range: `bytes=${start}-${start + 199}` } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes ${start}-${start + 199}/${video.length}`);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(video.subarray(start, start + 200)));
    const beyond = await call(`/stream/${view.base}`, { headers: { range: `bytes=${video.length + 10}-` } });
    assert.equal(beyond.status, 416);
    const external = await call('/stream/yt:dQw4w9WgXcQ');
    assert.equal(external.status, 400);
  });

  it('keeps everything across restarts, without adding the default nodes again', async () => {
    const before = await api<ClientState>('/api/state');
    await api('/api/nodes/' + encodeURIComponent(before.nodes[2].id), undefined, 'DELETE');
    await api<Settings>('/api/settings', { shareBaseUrl: 'https://example.org/elsewhere' }, 'PATCH');
    backend = await createBackend({ kv, config, appUrl, hostName: '127.0.0.1' });
    const after = await api<ClientState>('/api/state');
    assert.equal(after.identity.id, before.identity.id);
    assert.deepEqual(after.nodes.map((node) => node.name), ['Web CDN', 'Web Curator']);
    assert.equal(after.settings.shareBaseUrl, 'https://example.org/elsewhere');
    // Chunks come from the browser cache now: no credits spent.
    const balance = after.nodes[0].balance;
    const view = await api<ContentView>(`/api/content/${encodeURIComponent(id)}`);
    await (await call(`/stream/${view.base}`)).arrayBuffer();
    const account = await api<{ account: { balance: number } }>(`/api/nodes/${encodeURIComponent(after.nodes[0].id)}/account`);
    assert.equal(account.account.balance, balance);
  });

  it('answers like the daemon: errors, the storage service, http nodes from https pages', async () => {
    assert.equal((await call('/api/nope')).status, 404);
    const bad = await call('/api/settings', { method: 'PATCH', body: JSON.stringify({ pages: [{ id: 'x', layout: 'carousel' }] }) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: { message: string } }).error.message, /Unknown layout/);
    const service = await api<{ enabled: boolean; unavailable: string }>('/api/services');
    assert.equal(service.enabled, false);
    assert.match(service.unavailable, /desktop app/);
    const secure = await createBackend({ kv: memoryKeyValue(), config: {}, appUrl: 'https://example.org/vs/', hostName: 'example.org' });
    const refused = await call('/api/nodes', { method: 'POST', body: JSON.stringify({ text: 'http://203.0.113.5:7701' }) }, secure);
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /only let it reach nodes over https/);
    const state = (await (await call('/api/state', {}, secure)).json()) as ClientState;
    // Without a configured address, links point where the client is hosted.
    assert.equal(state.settings.shareBaseUrl, 'https://example.org/vs');
  });
});
