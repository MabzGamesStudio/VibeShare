// The client computes the content id of an upload before anything is published (it
// fills the suggest form with it), and can pull the data from a URL the same way.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import type { Job, PublishPreview } from '../src/shared/clientapi.js';
import { admin, randomBytesOf, startClient, startProvider, tempDir, waitFor } from './helpers.js';

describe('the client computes the content id before uploading', async () => {
  const provider = await startProvider({ name: 'Host' });
  const { dir, cleanup } = tempDir();
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    await provider.stop();
    cleanup();
  });
  await api('/api/nodes', { body: { text: provider.reference() } });

  it('fills the id field from a picked file and publishes under exactly that id', async () => {
    const video = randomBytesOf(3000);
    const { fileId } = await api<{ fileId: string }>('/api/upload', { raw: video });
    const preview = await api<PublishPreview>('/api/publish/preview', {
      body: { fileId, name: 'clip.bin', mime: 'application/octet-stream', title: 'clip.bin', sources: ['https://www.youtube.com/watch?v=abc'], sign: false },
    });
    assert.match(preview.cid, /^vs1[a-z2-7]{52}$/, 'the client calculated the content id');
    assert.match(preview.id, /~yt:abc$/, 'the full id carries the sources');
    const job = await api<Job>('/api/publish', {
      body: {
        fileId,
        name: 'clip.bin',
        mime: 'application/octet-stream',
        title: 'clip.bin',
        sources: ['https://www.youtube.com/watch?v=abc'],
        providers: [provider.identity.id],
        algorithms: [],
        sign: false,
        manifest: preview.manifest,
      },
    });
    const done = await waitFor(async () => {
      const current = await api<Job>(`/api/jobs/${job.id}`);
      return current.status !== 'running' && current;
    });
    assert.equal(done.status, 'done', JSON.stringify(done.steps));
    assert.equal(done.result?.id, preview.id, 'the uploaded content has the id the client showed');
    assert.ok(provider.store.getContent(preview.cid));
  });

  it('pulls the data from a URL and fills the id field the same way', async () => {
    const bytes = randomBytesOf(2048, 9);
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const pulled = await api<{ fileId: string; size: number; name: string; mime: string }>('/api/upload/url', {
        body: { url: `http://127.0.0.1:${port}/some/clip2.bin` },
      });
      assert.equal(pulled.size, bytes.length);
      assert.equal(pulled.name, 'clip2.bin');
      const preview = await api<PublishPreview>('/api/publish/preview', {
        body: { fileId: pulled.fileId, name: pulled.name, mime: pulled.mime, title: pulled.name, sign: false },
      });
      assert.match(preview.cid, /^vs1[a-z2-7]{52}$/);
      assert.equal(preview.size, bytes.length);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses URLs that are not http(s)', async () => {
    await assert.rejects(api('/api/upload/url', { body: { url: 'file:///etc/passwd' } }), /http/);
    await admin(provider.url(), '/v1/admin/status');
  });
});