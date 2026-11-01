import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ServiceStatus, ServiceVerifyReport } from '../src/shared/clientapi.js';
import { MiB } from '../src/shared/content.js';
import { clientFor, randomBytesOf, startClient, startProvider, tempDir, waitFor } from './helpers.js';

describe('storage service', async () => {
  const { dir, cleanup } = tempDir();
  const provider = await startProvider({ storage: { cacheMiB: 0 }, storageService: { challengeIntervalSeconds: 3600, minPassRatio: 0.5 } });
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    await provider.stop();
    cleanup();
  });

  it('challenges a holder fairly when the provider lost its own copy', async () => {
    const { cid, manifest } = await provider.importBuffer(randomBytesOf(2 * MiB, 5), { name: 'two.bin' });
    provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 1, durationSeconds: 3600, rewards: { upfront: 3, perRetrieval: 7, perChallenge: 2, completion: 0 } });
    await api('/api/nodes', { body: { text: provider.reference() } });
    await api('/api/settings', { method: 'PATCH', body: { storageService: { enabled: true, quotaGiB: 1 } } });
    await api('/api/services/sync', { method: 'POST' });
    await waitFor(() => provider.service.assignmentsForAdmin()[0]?.challenges.passed === 1);

    // The provider loses every copy it had; only the client still holds the data.
    for (const chunk of manifest.chunks) for (const backend of provider.backends()) await backend.delete(chunk.id);
    const assignment = provider.service.assignmentsForAdmin()[0];
    await (provider.service as unknown as { challenge(a: unknown): Promise<void> }).challenge(assignment);
    await waitFor(() => provider.service.assignmentsForAdmin()[0].challenges.passed === 2);
    const after = provider.service.assignmentsForAdmin()[0];
    assert.equal(after.retrievals, 0, 'the challenge did not turn into a paid retrieval');
    assert.equal(after.earned, 3 + 2 + 2);

    // Clients later ask the provider for the content: it fetches it back from the holder.
    const data = await provider.store.getChunk(manifest.chunks[0].id);
    assert.ok(data);
    assert.equal(provider.service.assignmentsForAdmin()[0].retrievals, 1);
    const status = await api<ServiceStatus>('/api/services');
    assert.equal(status.providers[0].assignments[0].status, 'active');
  });

  it('takes a holder out of the job when it answers with the wrong data', async () => {
    const { cid, manifest } = await provider.importBuffer(randomBytesOf(2 * MiB, 9), { name: 'bad.bin' });
    const job = provider.service.createJob({
      cid,
      chunks: manifest.chunks,
      replicas: 2,
      durationSeconds: 3600,
      rewards: { upfront: 1, perRetrieval: 1, perChallenge: 1, completion: 0 },
    });
    const user = clientFor(provider.url(), 'identity');
    await user.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    await user.json(`/v1/services/storage/assignments/${assignment.id}/ready`, { method: 'POST' });
    const account = (await user.json<{ account: { id: string } }>('/v1/account')).account;
    const fake = { id: account.id } as never;
    let taskId = '';
    await waitFor(async () => {
      const task = (await provider.service.poll(fake, 0)).find((entry) => entry.type === 'challenge');
      if (task) {
        taskId = task.id;
        return true;
      }
      return false;
    });
    const balanceBefore = provider.ledger.get(account.id)?.balance ?? 0;
    await assert.rejects(provider.service.answer(fake, taskId, Buffer.from('not the proof')), /Wrong proof/);
    assert.equal(
      provider.service.assignmentsForAdmin().find((entry) => entry.id === assignment.id)?.status,
      'failed',
      'a wrong answer takes the holder out of the job right away'
    );
    assert.equal(provider.ledger.get(account.id)?.balance ?? 0, balanceBefore, 'a wrong answer earns nothing');
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
});
