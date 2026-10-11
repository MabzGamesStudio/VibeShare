import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ServiceStatus } from '../src/shared/clientapi.js';
import { MiB } from '../src/shared/content.js';
import { randomBytesOf, startClient, startProvider, tempDir, waitFor } from './helpers.js';

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
});
