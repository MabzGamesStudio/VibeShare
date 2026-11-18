import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import type { ServiceStatus, ServiceVerifyReport } from '../../src/shared/clientapi.js';
import { MiB } from '../../src/shared/content.js';
import { admin, clientFor, randomBytesOf, startClient, startProvider, tempDir, waitFor } from '../helpers.js';

describe('storage service', async () => {
  const { dir, cleanup } = tempDir();
  const provider = await startProvider({ storage: { cacheMiB: 0 } });
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    await provider.stop();
    cleanup();
  });

  it('fetches a lost chunk back from the holder and pays per retrieval', async () => {
    const { cid, manifest } = await provider.importBuffer(randomBytesOf(2 * MiB, 5), { name: 'two.bin' });
    const job = provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 1, durationSeconds: 3600, rewards: { upfront: 3, perRetrieval: 7, completion: 0 } });
    await api('/api/nodes', { body: { text: provider.reference() } });
    await api('/api/settings', { method: 'PATCH', body: { storageService: { enabled: true, quotaGiB: 1 } } });
    await api('/api/services/sync', { method: 'POST' });
    const assignment = () => provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    await waitFor(async () => {
      const status = await api<ServiceStatus>('/api/services');
      return status.providers[0]?.assignments[0]?.status === 'active';
    });
    // 'active' means the client declared it stored the chunks; the provider also has to
    // count the holder online (it learns that from the holder's poll) before it can ask it
    // for a chunk. Waiting here keeps the test from racing that bookkeeping under load.
    await waitFor(async () => provider.service.stats().onlineHolders > 0);

    // The upfront reward is owed but unpaid: this holder never submitted a live endpoint.
    assert.equal(assignment().earned, 0, 'the upfront reward waits for a live endpoint');

    // The provider loses every copy it had; only the client still holds the data.
    for (const chunk of manifest.chunks) for (const backend of provider.backends()) await backend.delete(chunk.id);
    const data = await provider.store.getChunk(manifest.chunks[0].id);
    assert.ok(data);
    const after = assignment();
    assert.equal(after.retrievals, 1, 'the chunk came back through a paid retrieval');
    assert.equal(after.earned, 7, 'only the retrieval paid — the upfront reward is still owed');
    assert.equal(after.status, 'active');

    // Clients later ask the provider for the content: it is served from the fetched-back copy.
    const status = await api<ServiceStatus>('/api/services');
    assert.equal(status.providers[0].assignments[0].status, 'active');
  });

  it('pays the upfront reward only when the submitted endpoint is live', async () => {
    // A little host that serves the content — or 404s for the /gone/ URLs, like a dead
    // endpoint a user submitted.
    const blobs = new Map<string, Buffer>();
    const server = createServer((req, res) => {
      const cid = decodeURIComponent(req.url ?? '').split('/').pop() ?? '';
      const blob = req.url?.includes('/gone/') ? undefined : blobs.get(cid);
      if (!blob) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(blob);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const user = clientFor(provider.url(), 'identity');

      // Live at acceptance: the upfront reward is paid at once.
      const live = randomBytesOf(MiB, 21);
      const { cid: liveCid, manifest: liveManifest } = await provider.importBuffer(live, { name: 'live.bin' });
      blobs.set(liveCid, live);
      const liveJob = provider.service.createJob({ cid: liveCid, chunks: liveManifest.chunks, replicas: 2, durationSeconds: 3600, rewards: { upfront: 3, perRetrieval: 7, completion: 0 } });
      await user.json('/v1/content-urls', { body: { cid: liveCid, url: `http://127.0.0.1:${port}/files/${liveCid}` } });
      const acceptedLive = await user.json<{ id: string; earned: number }>(`/v1/services/storage/offers/${liveJob.id}/accept`, { method: 'POST' });
      assert.equal(acceptedLive.earned, 3, 'a live endpoint at acceptance earns the upfront reward right away');

      // Dead at acceptance: nothing is paid, and the first check that passes pays it.
      const later = randomBytesOf(MiB, 23);
      const { cid: laterCid, manifest: laterManifest } = await provider.importBuffer(later, { name: 'later.bin' });
      blobs.set(laterCid, later);
      const laterJob = provider.service.createJob({ cid: laterCid, chunks: laterManifest.chunks, replicas: 2, durationSeconds: 3600, rewards: { upfront: 5, perRetrieval: 7, completion: 0 } });
      await user.json('/v1/content-urls', { body: { cid: laterCid, url: `http://127.0.0.1:${port}/gone/${laterCid}` } });
      const acceptedLater = await user.json<{ id: string; earned: number }>(`/v1/services/storage/offers/${laterJob.id}/accept`, { method: 'POST' });
      assert.equal(acceptedLater.earned, 0, 'a dead endpoint at acceptance earns nothing yet');

      // The endpoint comes alive and passes its first check: the owed reward is paid.
      await user.json('/v1/content-urls', { body: { cid: laterCid, url: `http://127.0.0.1:${port}/files/${laterCid}` } });
      await provider.testStorageJob(laterJob.id);
      assert.equal(
        provider.service.assignmentsForAdmin().find((entry) => entry.id === acceptedLater.id)?.earned,
        5,
        'the first check that passes pays the upfront reward'
      );

      // The upfront reward is paid only once, ever.
      await provider.testStorageJob(liveJob.id);
      await provider.testStorageJob(laterJob.id);
      assert.equal(provider.service.assignmentsForAdmin().find((entry) => entry.id === acceptedLive.id)?.earned, 3);
      assert.equal(provider.service.assignmentsForAdmin().find((entry) => entry.id === acceptedLater.id)?.earned, 5);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('removes a holder that answers with the wrong data and reopens the job', async () => {
    const { cid, manifest } = await provider.importBuffer(randomBytesOf(2 * MiB, 9), { name: 'bad.bin' });
    const job = provider.service.createJob({
      cid,
      chunks: manifest.chunks,
      replicas: 2,
      durationSeconds: 3600,
      rewards: { upfront: 1, perRetrieval: 1, completion: 0 },
    });
    const first = clientFor(provider.url(), 'identity');
    await first.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    await first.json(`/v1/services/storage/assignments/${assignment.id}/ready`, { method: 'POST' });
    const account = (await first.json<{ account: { id: string } }>('/v1/account')).account;
    const fake = { id: account.id } as never;
    await provider.service.poll(fake, 0); // the holder comes online

    // A second holder fills the job completely.
    const second = clientFor(provider.url(), 'identity');
    await second.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const secondAssignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id && entry.id !== assignment.id)!;
    await second.json(`/v1/services/storage/assignments/${secondAssignment.id}/ready`, { method: 'POST' });
    const secondAccount = (await second.json<{ account: { id: string } }>('/v1/account')).account;
    const secondFake = { id: secondAccount.id } as never;
    await provider.service.poll(secondFake, 0);
    assert.equal(provider.service.jobs().find((entry) => entry.id === job.id)!.holders, 2, 'the job is full');
    const other = clientFor(provider.url(), 'identity');
    await assert.rejects(other.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' }), /no free slots/);

    // One holder answers a retrieval with the wrong bytes.
    const chunk = await provider.store.getChunk(manifest.chunks[0].id);
    assert.ok(chunk);
    const waiting = provider.service.retrieve(manifest.chunks[0].id);
    let wrongTask = '';
    let rightTask = '';
    await waitFor(async () => {
      wrongTask = ((await provider.service.poll(fake, 0)).find((entry) => entry.type === 'retrieve')?.id ?? '');
      rightTask = ((await provider.service.poll(secondFake, 0)).find((entry) => entry.type === 'retrieve')?.id ?? '');
      return Boolean(wrongTask && rightTask);
    });
    const balanceBefore = provider.ledger.get(account.id)?.balance ?? 0;
    await assert.rejects(provider.service.answer(fake, wrongTask, Buffer.from('not the bytes')), /do not match/);
    assert.equal(
      provider.service.assignmentsForAdmin().find((entry) => entry.id === assignment.id)?.status,
      'removed',
      'a wrong answer deletes the holder from the job — the row stays for display'
    );
    assert.equal(provider.ledger.get(account.id)?.balance ?? 0, balanceBefore, 'a wrong answer earns nothing');

    // The slot frees and the job reopens for another client.
    const reopened = provider.service.jobs().find((entry) => entry.id === job.id)!;
    assert.equal(reopened.reopened, 1);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.holders, 1, 'only the good holder is left');
    await other.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    assert.ok(
      provider.service.assignmentsForAdmin().filter((entry) => entry.jobId === job.id).length >= 3,
      'the freed slot is takeable again'
    );

    // The same retrieval still goes through the honest holder.
    await provider.service.answer(secondFake, rightTask, chunk);
    assert.ok(await waiting, 'the honest holder served the chunk');
  });

  it('frees the slot of an assignment that never finished downloading', async () => {
    const { cid, manifest } = await provider.importBuffer(randomBytesOf(2 * MiB, 11), { name: 'stuck.bin' });
    const job = provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 2, durationSeconds: 3600 });
    const user = clientFor(provider.url(), 'identity');
    await user.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const account = (await user.json<{ account: { id: string } }>('/v1/account')).account;
    const fake = { id: account.id } as never;
    const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    assert.equal(
      provider.service.offers(fake).some((offer) => offer.id === job.id),
      false,
      'a job being downloaded is not offered to the same account again'
    );
    // Pretend the download started long ago and never finished: the slot frees up.
    assignment.acceptedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    await waitFor(() => provider.service.assignmentsForAdmin().find((entry) => entry.id === assignment.id)?.status === 'released');
    assert.equal(
      provider.service.offers(fake).some((offer) => offer.id === job.id),
      true,
      'the job is open again for everyone'
    );
  });

  it('lists your own jobs by content id and tests the data on disk', async () => {
    const { cid, manifest } = await provider.importBuffer(randomBytesOf(MiB, 13), { name: 'own.bin' });
    await api('/api/services/sync', { method: 'POST' });
    const jobs = await api<{ items: { cid: string; source: string; jobId: string }[] }>(`/api/nodes/${provider.identity.id}/storage-jobs`);
    const item = jobs.items.find((entry) => entry.cid === cid);
    assert.ok(item, 'the job this account already holds is listed by its content id');
    assert.equal(item.source, 'your assignment');

    // The local copy matches the job's hashes — the "test my copy" check.
    const first = await api<{ reports: ServiceVerifyReport[] }>('/api/services/verify', { method: 'POST', body: {} });
    const report = first.reports.find((entry) => entry.jobId === item.jobId);
    assert.ok(report);
    assert.equal(report.complete, true, 'all chunks are on disk and hash exactly');
    assert.equal(report.ok, manifest.chunks.length);

    // A deleted chunk is reported as missing instead of silently passing.
    rmSync(join(dir, 'service', manifest.chunks[0].id), { force: true });
    const second = await api<{ reports: ServiceVerifyReport[] }>('/api/services/verify', { method: 'POST', body: {} });
    const after = second.reports.find((entry) => entry.jobId === item.jobId)!;
    assert.equal(after.complete, false);
    assert.equal(after.missing.length, 1);
    assert.equal(after.missing[0], manifest.chunks[0].id);
  });

  it('updates one job’s rewards and its retrieval schedule', async () => {
    const { cid, manifest } = await provider.importBuffer(randomBytesOf(MiB, 17), { name: 'sched.bin' });
    const job = provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 1, durationSeconds: 3600 });
    await admin(provider.url(), `/v1/admin/storage/jobs/${job.id}`, {
      method: 'POST',
      body: { rewards: { upfront: 9, perRetrieval: 4 }, retrievalIntervalSeconds: 300 },
    });
    const updated = provider.service.jobs().find((entry) => entry.id === job.id)!;
    assert.equal(updated.rewards.upfront, 9);
    assert.equal(updated.rewards.perRetrieval, 4);
    assert.equal(updated.rewards.completion, 10, 'untouched reward fields keep their value');
    assert.equal(updated.retrievalIntervalSeconds, 300);
  });

  it('serves a holder its chunk from a client URL job when the local copy is gone', async () => {
    // The job exists but the node's own copies are gone (released or never stored): the
    // URL jobs a client uploaded are the fallback, so the holder can still fill the job
    // instead of it sitting at 0/N forever.
    const data = randomBytesOf(2 * MiB, 31);
    const { cid, manifest } = await provider.importBuffer(data, { name: 'lost.bin' });
    const job = provider.service.createJob({
      cid,
      chunks: manifest.chunks,
      replicas: 1,
      durationSeconds: 3600,
      rewards: { upfront: 0, perRetrieval: 1, completion: 0 },
    });
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length) }).end(data);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const holder = clientFor(provider.url(), 'identity');
      await holder.json('/v1/content-urls', { body: { cid, url: `${origin}/files/${cid}` } });
      const assignment = await holder.json<{ id: string }>(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });

      // The node loses every copy it had; only the client's URL has the bytes.
      for (const chunk of manifest.chunks) for (const backend of provider.backends()) await backend.delete(chunk.id);
      assert.equal(await provider.store.getChunk(manifest.chunks[0].id), null, 'the node really lost the chunk');

      const answer = await holder.fetch(`/v1/services/storage/assignments/${assignment.id}/chunks/${manifest.chunks[0].id}`);
      assert.equal(answer.status, 200, 'the chunk is served from the URL-job copy');
      const got = Buffer.from(await answer.arrayBuffer());
      assert.deepEqual(got, data.subarray(0, manifest.chunks[0].size));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
