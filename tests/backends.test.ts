import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { contentIdOf, MiB, type Manifest } from '../src/shared/content.js';
import { clientFor, randomBytesOf, startProvider } from './helpers.js';

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse, data: Buffer) => unknown) {
  const server = createServer(async (req, res) => handler(req, res, await body(req)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

describe('storage backends', async () => {
  // WebDAV: needs Basic auth, directories made with MKCOL.
  const dav = new Map<string, Buffer>();
  const dirs = new Set<string>();
  const webdav = await serve((req, res, data) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('me:secret').toString('base64')}`) return res.writeHead(401).end();
    const path = decodeURIComponent(req.url ?? '');
    if (req.method === 'MKCOL') return dirs.add(path), res.writeHead(201).end();
    if (req.method === 'PUT') {
      if (!dirs.has(path.slice(0, path.lastIndexOf('/') + 1))) return res.writeHead(409).end();
      dav.set(path, data);
      return res.writeHead(201).end();
    }
    if (req.method === 'GET') return dav.has(path) ? res.writeHead(200).end(dav.get(path)) : res.writeHead(404).end();
    if (req.method === 'DELETE') return dav.delete(path), res.writeHead(204).end();
    if (req.method === 'PROPFIND') return res.writeHead(207).end('<multistatus/>');
    res.writeHead(405).end();
  });

  // IPFS (Kubo RPC): add returns a content hash the provider keeps as the locator.
  const ipfsStore = new Map<string, Buffer>();
  const ipfs = await serve(async (req, res, data) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/v0/add') {
      const form = await new Response(data, { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
      const file = Buffer.from(await (form.get('file') as File).arrayBuffer());
      const hash = 'bafk' + createHash('sha256').update(file).digest('hex').slice(0, 40);
      ipfsStore.set(hash, file);
      return res.writeHead(200).end(JSON.stringify({ Hash: hash }));
    }
    if (url.pathname === '/api/v0/cat') {
      const file = ipfsStore.get(url.searchParams.get('arg') ?? '');
      return file ? res.writeHead(200).end(file) : res.writeHead(404).end();
    }
    if (url.pathname === '/api/v0/version') return res.writeHead(200).end(JSON.stringify({ Version: '0.30.0' }));
    if (url.pathname === '/api/v0/pin/rm') return res.writeHead(200).end('{}');
    res.writeHead(404).end();
  });

  // S3: checks that requests are signed and the payload hash matches.
  const bucket = new Map<string, Buffer>();
  const s3 = await serve((req, res, data) => {
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=AKID/')) return res.writeHead(403).end();
    if (req.headers['x-amz-content-sha256'] !== createHash('sha256').update(data).digest('hex')) return res.writeHead(400).end('bad hash');
    const key = (req.url ?? '').split('?')[0];
    if (req.method === 'PUT') return bucket.set(key, data), res.writeHead(200).end();
    if (req.method === 'GET' && key.endsWith('/bucket')) return res.writeHead(200).end('<ListBucketResult/>');
    if (req.method === 'GET') return bucket.has(key) ? res.writeHead(200).end(bucket.get(key)) : res.writeHead(404).end();
    if (req.method === 'DELETE') return bucket.delete(key), res.writeHead(204).end();
    res.writeHead(405).end();
  });

  const provider = await startProvider({
    signup: { grant: 1000 },
    pricing: { perMiB: 1, freeMiBPerDay: 0 },
    storage: {
      replication: 3,
      cacheMiB: 0,
      backends: [
        { id: 'dav', type: 'webdav', url: `${webdav.url}/store`, username: 'me', password: 'secret', priority: 1 },
        { id: 'ipfs', type: 'ipfs', apiUrl: ipfs.url, priority: 2 },
        { id: 's3', type: 's3', endpoint: s3.url, region: 'us-east-1', bucket: 'bucket', accessKeyId: 'AKID', secretAccessKey: 'SECRET', priority: 3 },
      ],
    },
  });
  after(async () => {
    await provider.stop();
    webdav.close();
    ipfs.close();
    s3.close();
  });

  const data = randomBytesOf(Math.floor(1.5 * MiB), 3);
  let manifest: Manifest;

  it('replicates every chunk to WebDAV, IPFS and S3', async () => {
    ({ manifest } = await provider.importBuffer(data, { name: 'clip.bin' }));
    const record = provider.store.chunkRecord(manifest.chunks[0].id)!;
    assert.deepEqual(Object.keys(record.locations).sort(), ['dav', 'ipfs', 's3']);
    assert.match(record.locations.ipfs, /^bafk/);
    assert.equal(dav.size, 2 + 1, 'two chunks and the manifest');
    assert.equal(ipfsStore.size, 3);
    assert.equal(bucket.size, 3);
    const status = await fetch(`${provider.url()}/v1/admin/storage/backends`, { headers: { 'x-admin-token': 'test-admin-token' } });
    const { backends } = (await status.json()) as { backends: { id: string; status: { ok: boolean } }[] };
    assert.deepEqual(backends.map((b) => [b.id, b.status.ok]), [['dav', true], ['ipfs', true], ['s3', true]]);
  });

  it('falls back to the next backend when one loses data', async () => {
    dav.clear();
    for (const key of [...bucket.keys()]) bucket.delete(key);
    const viewer = clientFor(provider.url());
    const cid = contentIdOf(manifest);
    const response = await viewer.fetch(`/v1/chunks/${manifest.chunks[0].id}?cid=${cid}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, data.subarray(0, MiB), 'served from IPFS');
  });
});

describe('a provider mirroring another provider', async () => {
  const origin = await startProvider({ name: 'Origin', signup: { grant: 100 }, pricing: { perMiB: 1, freeMiBPerDay: 0 } });
  const edge = await startProvider({
    name: 'Edge',
    signup: { grant: 100 },
    pricing: { perMiB: 2, freeMiBPerDay: 0 },
    storage: { backends: [{ id: 'cache', type: 'memory' }, { id: 'origin', type: 'provider', ref: origin.reference(), priority: 50 }] },
  });
  after(async () => {
    await edge.stop();
    await origin.stop();
  });

  it('serves content it never stored, paying the origin from its own account', async () => {
    const data = randomBytesOf(MiB + 10, 9);
    const { cid, manifest } = await origin.importBuffer(data, { name: 'song.bin' });
    const viewer = clientFor(edge.url());
    const fetched = await viewer.json<Manifest>(`/v1/content/${cid}`);
    assert.equal(contentIdOf(fetched), cid);
    const parts: Buffer[] = [];
    for (const chunk of manifest.chunks) parts.push(Buffer.from(await (await viewer.fetch(`/v1/chunks/${chunk.id}?cid=${cid}`)).arrayBuffer()));
    assert.deepEqual(Buffer.concat(parts), data);
    const edgeAccountOnOrigin = origin.ledger.get(edge.identity.id)!;
    assert.equal(edgeAccountOnOrigin.balance, 100 - 2, 'the edge paid the origin 1 credit per MiB');
    // The edge kept a copy: a second viewer costs the origin nothing more.
    const second = clientFor(edge.url());
    await second.fetch(`/v1/chunks/${manifest.chunks[0].id}?cid=${cid}`);
    assert.equal(origin.ledger.get(edge.identity.id)!.balance, 98);
  });
});
