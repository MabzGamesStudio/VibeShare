// The storage-job check state machine: strikes before removal, successes that keep or
// restore holders, partial-success results, offer filtering, and the startup round.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { MiB } from '../../src/shared/content.js';
import { admin, clientFor, randomBytesOf, startProvider, waitFor } from '../helpers.js';

/** A little host that serves the content — or 404s the /gone/ URLs, like a dead endpoint. */
function serveBlobs() {
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
  return {
    blobs,
    listen: () => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('storage job endpoint checks', async () => {
  const host = serveBlobs();
  const port = await host.listen();
  const provider = await startProvider({ pricing: { perMiB: 0 } });
  after(async () => {
    await provider.stop();
    await host.close();
  });

  const deadUrl = (cid: string) => `http://127.0.0.1:${port}/gone/${cid}`;
  const goodUrl = (cid: string) => `http://127.0.0.1:${port}/files/${cid}`;
  const jobState = (jobId: string) => provider.service.jobs().find((entry) => entry.id === jobId)!;
  const holderOf = (id: string) => provider.service.assignmentsForAdmin().find((entry) => entry.id === id)!;

  /** One content, one job, one holder whose only endpoint is dead. */
  const withDeadHolder = async (name: string) => {
    const data = randomBytesOf(MiB, name.length * 11);
    const { cid, manifest } = await provider.importBuffer(data, { name });
    host.blobs.set(cid, data);
    const job = provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 1, durationSeconds: 3600, rewards: { upfront: 0, perRetrieval: 0, completion: 0 } });
    const user = clientFor(provider.url(), 'identity');
    await user.json('/v1/content-urls', { body: { cid, url: deadUrl(cid) } });
    await user.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    await user.json(`/v1/services/storage/assignments/${assignment.id}/ready`, { method: 'POST' });
    return { cid, job, user, assignment };
  };

  it('keeps the holder on one failed check and removes it on three, reopening the job', async () => {
    const { job, assignment } = await withDeadHolder('strikes.bin');

    // The first failed round is only a strike — the holder stays fully active.
    const first = await provider.testStorageJob(job.id);
    assert.equal(first.ok, false);
    assert.deepEqual(first.holders, { succeeded: 0, total: 1 });
    assert.deepEqual(first.urls, { served: 0, checked: 1 });
    assert.ok(first.error, 'nothing served is reported as an error');
    assert.equal(holderOf(assignment.id).status, 'active');
    assert.equal(holderOf(assignment.id).failedChecks, 1);

    const second = await provider.testStorageJob(job.id);
    assert.equal(holderOf(assignment.id).status, 'active');
    assert.equal(holderOf(assignment.id).failedChecks, 2);

    // The third consecutive failure removes the holder and reopens the job.
    const third = await provider.testStorageJob(job.id);
    assert.equal(third.ok, false);
    assert.equal(holderOf(assignment.id).status, 'removed', 'three consecutive failed checks delete the holder');
    await waitFor(() => jobState(job.id).reopened === 1);
    // The job data is right here on the node, so losing the holder never labels the job
    // failed — give any (wrong) failure path time to land before checking.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(jobState(job.id).status, 'open', 'the job is open again, not failed');
    assert.equal(jobState(job.id).holders, 0);
  });

  it('resets the failure streak and keeps the holder when a check passes', async () => {
    const { cid, job, user, assignment } = await withDeadHolder('kept.bin');
    await provider.testStorageJob(job.id);
    await provider.testStorageJob(job.id);
    assert.equal(holderOf(assignment.id).failedChecks, 2);

    // The endpoint comes alive: one success wipes the whole streak…
    await user.json('/v1/content-urls', { body: { cid, url: goodUrl(cid) } });
    const pass = await provider.testStorageJob(job.id, holderOf(assignment.id).accountId);
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.holders, { succeeded: 1, total: 1 }, 'the per-account path reports the same shape');
    assert.equal(pass.account, holderOf(assignment.id).accountId);
    assert.equal(holderOf(assignment.id).status, 'active', 'a success keeps the holder');
    assert.equal(holderOf(assignment.id).failedChecks, 0);

    // …and the stale `fails` of the dead endpoint must not keep the row looking failed.
    const records = Object.values((provider as unknown as { contentUrls: { data: { items: Record<string, { account: string; fails?: number }> } } }).contentUrls.data.items).filter(
      (record) => record.account === holderOf(assignment.id).accountId
    );
    assert.ok(records.length >= 2);
    assert.ok(records.every((record) => !record.fails), 'every endpoint of the row is clean after a success');
  });

  it('restores a holder that earlier failures removed', async () => {
    const { cid, job, user, assignment } = await withDeadHolder('restored.bin');
    for (let round = 0; round < 3; round++) await provider.testStorageJob(job.id);
    assert.equal(holderOf(assignment.id).status, 'removed');

    // The operator adds a working endpoint and tests again: the removed holder is
    // tested (no "That user is not part of this job") and comes back at once.
    await user.json('/v1/content-urls', { body: { cid, url: goodUrl(cid) } });
    const pass = await provider.testStorageJob(job.id, holderOf(assignment.id).accountId);
    assert.equal(pass.ok, true);
    assert.equal(pass.error, undefined);
    assert.equal(holderOf(assignment.id).status, 'active', 'a passing check restores the holder');
    assert.equal(holderOf(assignment.id).failedChecks, 0);
  });

  it('counts a partial success as success and reports holder counts', async () => {
    const data = randomBytesOf(MiB, 77);
    const { cid, manifest } = await provider.importBuffer(data, { name: 'partial.bin' });
    host.blobs.set(cid, data);
    const job = provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 2, durationSeconds: 3600, rewards: { upfront: 0, perRetrieval: 0, completion: 0 } });
    const good = clientFor(provider.url(), 'identity');
    await good.json('/v1/content-urls', { body: { cid, url: goodUrl(cid) } });
    await good.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const goodAssignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    await good.json(`/v1/services/storage/assignments/${goodAssignment.id}/ready`, { method: 'POST' });
    const dead = clientFor(provider.url(), 'identity');
    await dead.json('/v1/content-urls', { body: { cid, url: deadUrl(cid) } });
    await dead.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const deadAssignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id && entry.id !== goodAssignment.id)!;
    await dead.json(`/v1/services/storage/assignments/${deadAssignment.id}/ready`, { method: 'POST' });

    const result = await provider.testStorageJob(job.id);
    assert.equal(result.ok, true, 'one of two holders serving is success');
    assert.deepEqual(result.holders, { succeeded: 1, total: 2 });
    assert.deepEqual(result.urls, { served: 1, checked: 2 });
    assert.equal(result.error, undefined, 'a partial success carries no error');
    assert.equal(result.checked, 2);
    assert.equal(result.total, 2);
  });

  it('never offers a job the account already holds — even after removal', async () => {
    const data = randomBytesOf(MiB, 99);
    const { cid, manifest } = await provider.importBuffer(data, { name: 'offers.bin' });
    host.blobs.set(cid, data);
    const job = provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 2, durationSeconds: 3600, rewards: { upfront: 0, perRetrieval: 0, completion: 0 } });
    const user = clientFor(provider.url(), 'identity');
    await user.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const account = (await user.json<{ account: { id: string } }>('/v1/account')).account;
    const fake = { id: account.id } as never;
    const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    assert.equal(provider.service.offers(fake).some((offer) => offer.id === job.id), false, 'a job being held is not offered again');

    // Removed by failing checks: still not offered — the job must not bounce back to
    // the client that just lost it.
    provider.service.failHolder(assignment.id);
    assert.equal(holderOf(assignment.id).status, 'removed');
    assert.equal(provider.service.offers(fake).some((offer) => offer.id === job.id), false, 'a removed holder is not re-offered the job');
  });
  it('a successful URL check in the admin pays the owed upfront, clears the strikes and restores the holder', async () => {
    // A user whose URL was dead (two strikes) fixes it: testing that URL from the admin is
    // the operator saying "this works now", so the user counts again and gets the credit.
    const data = randomBytesOf(MiB, 77);
    const { cid, manifest } = await provider.importBuffer(data, { name: 'healed.bin' });
    host.blobs.set(cid, data);
    const job = provider.service.createJob({
      cid,
      chunks: manifest.chunks,
      replicas: 2,
      durationSeconds: 3600,
      rewards: { upfront: 5, perRetrieval: 1, completion: 0 },
    });
    const user = clientFor(provider.url(), 'identity');
    await user.json('/v1/content-urls', { body: { cid, url: deadUrl(cid) } });
    await user.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    await user.json(`/v1/services/storage/assignments/${assignment.id}/ready`, { method: 'POST' });

    await provider.testStorageJob(job.id);
    await provider.testStorageJob(job.id);
    assert.equal(holderOf(assignment.id).failedChecks, 2, 'two failed rounds are two strikes');

    const details = await admin<{ urls: { id: string; cid?: string }[] }>(provider.url(), `/v1/admin/content/${encodeURIComponent(cid)}`);
    const link = details.urls.find((entry) => entry.cid === cid)!;
    const { verify } = await admin<{ verify: { ok: boolean } }>(provider.url(), `/v1/admin/content/${encodeURIComponent(cid)}/verify`, {
      body: { url: goodUrl(cid), linkId: link.id },
    });
    assert.equal(verify.ok, true, 'the good URL passes the check');
    const healed = holderOf(assignment.id);
    assert.equal(healed.failedChecks, 0, 'the strikes are cleared');
    assert.equal(healed.status, 'active');
    assert.equal(healed.earned, 5, 'the owed upfront reward is paid');
    const state = jobState(job.id);
    assert.ok(state.lastEndpointTestAt, 'the check records when the endpoints were last tested');
    assert.notEqual(state.status, 'failed', 'a job with a working user is not failed');
  });

  it('tests a never-tested job on the next round instead of waiting the whole interval', async () => {
    const data = randomBytesOf(MiB, 91);
    const { cid, manifest } = await provider.importBuffer(data, { name: 'fresh.bin' });
    host.blobs.set(cid, data);
    const job = provider.service.createJob({
      cid,
      chunks: manifest.chunks,
      replicas: 1,
      durationSeconds: 3600,
      retrievalIntervalSeconds: 3600,
      rewards: { upfront: 0, perRetrieval: 0, completion: 0 },
    });
    assert.equal(jobState(job.id).lastEndpointTestAt, undefined);
    // One scheduler round (the path the 30-second timer takes) must pick it up now.
    await (provider as unknown as { runEndpointTests(all?: boolean): Promise<void> }).runEndpointTests(false);
    assert.ok(jobState(job.id).lastEndpointTestAt, 'the first test runs at once and is persisted');
  });

  it('probes a freshly offered URL and counts the copy as fulfilled right away', async () => {
    // The client offers its URL after the node started (the usual startup order): the
    // node checks it at once, the downloading holder becomes live, and the copy counts
    // in the admin list before any manual Test or scheduled round.
    const data = randomBytesOf(MiB, 121);
    const { cid, manifest } = await provider.importBuffer(data, { name: 'offered.bin' });
    host.blobs.set(cid, data);
    const job = provider.service.createJob({
      cid,
      chunks: manifest.chunks,
      replicas: 2,
      durationSeconds: 3600,
      rewards: { upfront: 4, perRetrieval: 1, completion: 0 },
    });
    const user = clientFor(provider.url(), 'identity');
    await user.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    assert.equal(assignment.status, 'downloading');
    // Offer the working URL now: the node probes it and the holder counts.
    await user.json('/v1/content-urls', { body: { cid, url: goodUrl(cid) } });
    await waitFor(() => holderOf(assignment.id).status === 'active');
    assert.equal(holderOf(assignment.id).earned, 4, 'the owed upfront is paid by the passing probe');
    const listed = await admin<{ jobs: { id: string; holders: number }[] }>(provider.url(), '/v1/admin/storage/jobs');
    assert.equal(listed.jobs.find((entry) => entry.id === job.id)?.holders, 1, 'one of two copies is fulfilled');
  });

  it('tests a holder the node had let go (released) instead of saying it is not part of the job', async () => {
    // The operator sees the row in the modal and presses Test: the row's status (released,
    // completed, failed…) must not decide whether the URL is checked — the URL does.
    const data = randomBytesOf(MiB, 133);
    const { cid, manifest } = await provider.importBuffer(data, { name: 'released.bin' });
    host.blobs.set(cid, data);
    const job = provider.service.createJob({
      cid,
      chunks: manifest.chunks,
      replicas: 2,
      durationSeconds: 3600,
      rewards: { upfront: 3, perRetrieval: 1, completion: 0 },
    });
    const user = clientFor(provider.url(), 'identity');
    await user.json('/v1/content-urls', { body: { cid, url: goodUrl(cid) } });
    await user.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    await user.json(`/v1/services/storage/assignments/${assignment.id}/ready`, { method: 'POST' });
    await user.json(`/v1/services/storage/assignments/${assignment.id}/release`, { method: 'POST' });
    assert.equal(holderOf(assignment.id).status, 'released');

    const result = await provider.testStorageJob(job.id, assignment.accountId);
    assert.equal(result.ok, true, 'the working URL is what decides, not the row status');
    assert.deepEqual(result.holders, { succeeded: 1, total: 1 });
    assert.equal(holderOf(assignment.id).status, 'active', 'the passing check brings the copy back');
  });
});

describe('the startup test round', async () => {
  const host = serveBlobs();
  const port = await host.listen();
  const provider = await startProvider({ pricing: { perMiB: 0 } });
  after(async () => {
    await provider.stop();
    await host.close();
  });

  it('refreshes a stale assignment status when the node starts', async () => {
    const data = randomBytesOf(MiB, 33);
    const { cid, manifest } = await provider.importBuffer(data, { name: 'stale.bin' });
    host.blobs.set(cid, data);
    const job = provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 1, durationSeconds: 3600, rewards: { upfront: 0, perRetrieval: 0, completion: 0 } });
    const user = clientFor(provider.url(), 'identity');
    await user.json('/v1/content-urls', { body: { cid, url: `http://127.0.0.1:${port}/files/${cid}` } });
    await user.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
    const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
    await user.json(`/v1/services/storage/assignments/${assignment.id}/ready`, { method: 'POST' });

    // A row left behind by the old one-strike behaviour: removed although its endpoint
    // serves the content perfectly.
    assignment.status = 'removed';

    await provider.stop();
    await provider.start();
    await waitFor(() => provider.service.assignmentsForAdmin().find((entry) => entry.id === assignment.id)?.status === 'active');
    assert.equal(provider.service.assignmentsForAdmin().find((entry) => entry.id === assignment.id)?.failedChecks, 0);
  });

});
