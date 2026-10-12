import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FeedResponse, NodeEntry, Settings } from '../src/shared/clientapi.js';
import { parseSocksAddress, torFetch, TorRouter } from '../src/shared/tor.js';
import { startFakeTor, type FakeTor } from './faketor.js';
import { admin, startAlgorithm, startClient, tempDir } from './helpers.js';

describe('fetch through Tor', () => {
  let tor: FakeTor;
  let server: Server;
  before(async () => {
    tor = await startFakeTor();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (data) => (body += data));
      req.on('end', () => {
        if (req.url === '/moved') return void res.writeHead(302, { location: '/here' }).end();
        if (req.url === '/away') return void res.writeHead(307, { location: 'http://otherexample.onion/landing' }).end();
        res.writeHead(200, { 'content-type': 'application/json', 'x-vs-balance': '7' });
        res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body, authorization: req.headers.authorization }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    tor.onions.set('exampleexample.onion', (server.address() as AddressInfo).port);
    tor.onions.set('otherexample.onion', (server.address() as AddressInfo).port);
  });
  after(async () => {
    server.close();
    await tor.close();
  });

  it('lets Tor resolve the name and keeps each host on its own circuits', async () => {
    const send = torFetch({ proxy: { host: '127.0.0.1', port: tor.socksPort } });
    const got = await send('http://exampleexample.onion/hello?x=1');
    assert.deepEqual(await got.json(), { method: 'GET', url: '/hello?x=1', host: 'exampleexample.onion', body: '' });
    const away = (await (await send('http://exampleexample.onion/away', { headers: { authorization: 'Bearer secret' } })).json()) as Record<string, string>;
    assert.deepEqual([away.host, away.url, away.authorization], ['otherexample.onion', '/landing', undefined], 'no token for another site');
    const same = (await (await send('http://exampleexample.onion/moved', { headers: { authorization: 'Bearer secret' } })).json()) as Record<string, string>;
    assert.equal(same.authorization, 'Bearer secret');
    const posted = await send('http://exampleexample.onion/post', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    assert.equal(posted.headers.get('x-vs-balance'), '7');
    assert.equal(((await posted.json()) as { body: string }).body, '{"a":1}');
    assert.equal(((await (await send('http://exampleexample.onion/moved')).json()) as { url: string }).url, '/here');
    const manual = await send('http://exampleexample.onion/moved', { redirect: 'manual' });
    assert.deepEqual([manual.status, manual.headers.get('location')], [302, '/here']);
    assert.ok(tor.requests.every((request) => request.username === `vibeshare:${request.host}`));
  });

  it('explains what went wrong', async () => {
    const send = torFetch({ proxy: { host: '127.0.0.1', port: tor.socksPort } });
    await assert.rejects(send('http://gone.onion/'), /onion service not found/);
    const closed = torFetch({ proxy: { host: '127.0.0.1', port: 9 } });
    await assert.rejects(closed('http://exampleexample.onion/'), /Tor is not running at 127\.0\.0\.1:9/);
    await assert.rejects(send('http://exampleexample.onion/', { signal: AbortSignal.timeout(1) }), { name: 'TimeoutError' });
  });

  it('routes by mode: onion addresses, everything but local addresses, or nothing', () => {
    let mode: 'off' | 'onion' | 'all' = 'onion';
    const router = new TorRouter(() => ({ mode, proxy: '' }));
    assert.equal(router.routes('http://abc.onion/x'), true);
    assert.equal(router.routes('https://cdn.example.org/'), false);
    mode = 'all';
    assert.equal(router.routes('https://cdn.example.org/'), true);
    assert.equal(router.routes('http://127.0.0.1:7701/'), false, 'local nodes stay direct');
    assert.equal(router.routes('http://[::1]:7701/'), false);
    mode = 'off';
    assert.equal(router.routes('http://abc.onion/x'), false);
    assert.deepEqual(parseSocksAddress('socks5h://[::1]:9150'), { host: '::1', port: 9150 });
    assert.deepEqual(parseSocksAddress('localhost'), { host: 'localhost', port: 9050 });
  });
});

describe('nodes and clients on Tor', async () => {
  const tor = await startFakeTor('secret');
  const { dir, cleanup } = tempDir();
  const nodeDir = `${dir}/algorithm`;
  const torConfig = { onionService: true, controlPort: `127.0.0.1:${tor.controlPort}`, controlPassword: 'secret', proxy: `127.0.0.1:${tor.socksPort}` };
  let algorithm = await startAlgorithm({ name: 'Hidden curator', tor: torConfig }, nodeDir);
  const { client, api } = await startClient(`${dir}/client`);
  after(async () => {
    await client.stop();
    await algorithm.stop();
    await tor.close();
    cleanup();
  });
  await admin(algorithm.url(), '/v1/admin/content', { method: 'PUT', body: { id: 'yt:tor1', title: 'Onion soup', format: 'video' } });
  const proxy = `127.0.0.1:${tor.socksPort}`;
  const setTor = (tor: Partial<Settings['tor']>) => api<Settings>('/api/settings', { method: 'PATCH', body: { tor: { proxy, ...tor } } });

  it('publishes the node as an onion service and keeps its address across restarts', async () => {
    const onion = algorithm.onionUrl()!;
    assert.match(onion, /^http:\/\/[a-z0-9]{56}\.onion$/);
    assert.ok(tor.commands.includes('AUTHENTICATE "secret"'));
    assert.ok(tor.commands.some((command) => command.startsWith('ADD_ONION NEW:ED25519-V3 Port=80,127.0.0.1:')));
    assert.ok(algorithm.reference().endsWith(`@${onion}`), 'without a public URL, the onion address is the one to share');
    assert.equal(algorithm.signedInfo().info.onion, onion);
    const port = algorithm.port;
    await algorithm.stop();
    await new Promise((resolve) => setTimeout(resolve, 50)); // (the control connection closing reaches Tor)
    assert.ok(!tor.onions.has(new URL(onion).hostname), 'the service ends with the node');
    algorithm = await startAlgorithm({ name: 'Hidden curator', port, tor: torConfig }, nodeDir);
    assert.equal(algorithm.onionUrl(), onion, 'same key, same address');
    assert.ok(tor.commands.at(-1)!.startsWith('ADD_ONION ED25519-V3:'));
  });

  it('lets a client reach an onion-only node through Tor', async () => {
    await setTor({ mode: 'onion' });
    const before = tor.requests.length;
    const added = await api<{ added: NodeEntry[]; errors: unknown[] }>('/api/nodes', { body: { text: algorithm.reference() } });
    assert.equal(added.added.length, 1, JSON.stringify(added.errors));
    const feed = await api<FeedResponse>('/api/feed', { body: {} });
    assert.deepEqual(feed.items.map((item) => item.title), ['Onion soup']);
    const onionHost = new URL(algorithm.onionUrl()!).hostname;
    assert.ok(tor.requests.slice(before).length >= 2);
    assert.ok(tor.requests.slice(before).every((request) => request.host === onionHost));
  });

  it('cannot reach it with Tor off, and says why', async () => {
    await setTor({ mode: 'off' });
    const feed = await api<FeedResponse>('/api/feed', { body: {} });
    assert.equal(feed.items.length, 0);
    assert.match(feed.errors[0].error, /onion service: turn Tor on/);
    await setTor({ mode: 'onion' });
  });

  it('in "all" mode uses the onion address of a node that has one', async () => {
    // The same node, added under its ordinary address.
    const direct = `vs:algorithm:${algorithm.identity.id}@http://127.0.0.1:${algorithm.port}`;
    await api(`/api/nodes/${algorithm.identity.id}`, { method: 'DELETE' });
    await api('/api/nodes', { body: { text: direct } });
    const onionHost = new URL(algorithm.onionUrl()!).hostname;
    let before = tor.requests.length;
    await api<FeedResponse>('/api/feed', { body: {} });
    assert.equal(tor.requests.length, before, '"onion" mode: an ordinary address is reached directly');
    await setTor({ mode: 'all' });
    before = tor.requests.length;
    const feed = await api<FeedResponse>('/api/feed', { body: {} });
    assert.deepEqual(feed.items.map((item) => item.title), ['Onion soup']);
    assert.ok(tor.requests.slice(before).some((request) => request.host === onionHost));
  });

  it('tests the Tor connection from the settings', async () => {
    const check = await api<{ ok: boolean; proxy?: string; error?: string }>('/api/tor/check', { method: 'POST' });
    assert.equal(check.ok, false);
    assert.equal(check.proxy, proxy);
    assert.match(check.error ?? '', /check\.torproject\.org/);
    await assert.rejects(setTor({ proxy: 'not a proxy!' }), /host:port/);
  });

  it('sends the crawler through Tor without looking names up itself', async () => {
    await admin(algorithm.url(), '/v1/admin/config', { method: 'PUT', body: { tor: { outbound: 'all' } } });
    const before = tor.requests.length;
    // (Tor cannot reach the site here, so not even its robots.txt: the page is left alone.)
    await assert.rejects(algorithm.crawler.fetcher.get('https://videos.example.org/page'), /robots\.txt disallows/);
    assert.deepEqual(
      tor.requests.slice(before).map((request) => `${request.host}:${request.port}`),
      ['videos.example.org:443']
    );
  });
});
