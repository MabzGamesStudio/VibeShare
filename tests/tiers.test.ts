import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { MiB } from '../src/shared/content.js';
import { admin, clientFor, randomBytesOf, startProvider } from './helpers.js';

describe('content storage tiers', () => {
  it('assigns the default tier, prices upgrades by size, and runs the lifecycles', async () => {
    const provider = await startProvider();
    try {
      const { cid } = await provider.importBuffer(randomBytesOf(2 * MiB), { name: 'two.bin' });

      // Every upload lands in the default tier with its lifecycle running.
      const first = await clientFor(provider.url(), 'identity').json<{
        tier: { tier: string; plan: { externalUrls: number }; daysLeft?: number };
      }>(`/v1/content/${cid}/tier`);
      assert.equal(first.tier.tier, 'bronze');
      assert.equal(first.tier.plan.externalUrls, 2);
      assert.ok((first.tier.daysLeft ?? 0) > 0, 'the lifecycle is running');

      // A user pays credits to raise the tier — priced by the content's size.
      const user = clientFor(provider.url(), 'identity');
      const before = (await user.json<{ account: { balance: number } }>('/v1/account')).account.balance;
      const raised = await user.json<{ charged: number; state: { tier: string; manual?: boolean } }>(`/v1/content/${cid}/tier`, {
        method: 'POST',
        body: { tier: 'gold' },
      });
      assert.equal(raised.state.tier, 'gold');
      assert.equal(raised.charged, 6, 'gold costs 3 credits per MiB of 2 MiB');
      assert.equal((await user.json<{ account: { balance: number } }>('/v1/account')).account.balance, before - 6);
      assert.equal(raised.state.manual, true, 'a paid choice is kept by hand');

      // The operator can change any assignment by hand and forget it entirely.
      await admin(provider.url(), `/v1/admin/tiers/${cid}`, { body: { tier: 'silver' } });
      const all = await admin<{ assignments: { cid: string; tier: string }[] }>(provider.url(), '/v1/admin/tiers');
      assert.equal(all.assignments.find((entry) => entry.cid === cid)?.tier, 'silver');
      await admin(provider.url(), `/v1/admin/tiers/${cid}`, { method: 'DELETE' });
      assert.equal(provider.tiers.stateOf(cid), undefined, 'forgotten assignments are gone');
    } finally {
      await provider.stop();
    }
  });

  it('keeps URL backups domain-first and downgrades expired content along its chain', async () => {
    const provider = await startProvider();
    try {
      const { cid } = await provider.importBuffer(randomBytesOf(MiB), { name: 'one.bin' });
      const user = clientFor(provider.url(), 'identity');

      // Two backups on one domain count while no other domain is on offer — the state
      // says how many distinct domains stand behind them.
      await user.json('/v1/content-urls', { body: { cid, url: 'https://backup.example/one' } });
      await user.json('/v1/content-urls', { body: { cid, url: 'https://backup.example/two' } });
      let state = (await user.json<{ tier: { backups: { urls: number; domains: string[]; note?: string } } }>(`/v1/content/${cid}/tier`)).tier;
      assert.equal(state.backups.urls, 2);
      assert.deepEqual(state.backups.domains, ['backup.example']);

      // A second domain arrives: one backup per domain counts first from there on.
      await user.json('/v1/content-urls', { body: { cid, url: 'https://mirror.example/one' } });
      state = (await user.json<{ tier: { backups: { urls: number; domains: string[] } } }>(`/v1/content/${cid}/tier`)).tier;
      assert.equal(state.backups.domains.length, 2);

      // Silver expires back to bronze; bronze expires to completely forgotten.
      provider.tiers.setTier(cid, 'silver');
      provider.tiers.extend(cid, -400);
      await provider.tiers.tick();
      assert.equal(provider.tiers.stateOf(cid)?.tier, 'bronze', 'expired silver downgrades along its chain');
      provider.tiers.extend(cid, -400);
      await provider.tiers.tick();
      assert.equal(provider.tiers.stateOf(cid), undefined, 'expired bronze is completely forgotten');
    } finally {
      await provider.stop();
    }
  });

  it('buys the first tier with credits, keeps one copy per user, and drops holders that fail retrievals', async () => {
    const provider = await startProvider();
    try {
      // Automatic assignment off: uploads land unassigned and users buy the first tier.
      await admin(provider.url(), '/v1/admin/config', { method: 'PUT', body: { tiers: { auto: false } } });
      const { cid, manifest } = await provider.importBuffer(randomBytesOf(MiB), { name: 'one.bin' });
      const user = clientFor(provider.url(), 'identity');

      // Unassigned content still shows the upgrade menu — the first tier is bought outright.
      const preview = await user.json<{ tier: { tier: string; upgrades: { id: string; price: number }[] } }>(`/v1/content/${cid}/tier`);
      assert.equal(preview.tier.tier, '');
      const bought = await user.json<{ charged: number; state: { tier: string } }>(`/v1/content/${cid}/tier`, {
        method: 'POST',
        body: { tier: 'silver' },
      });
      assert.equal(bought.state.tier, 'silver');
      assert.equal(bought.charged, 1, 'silver costs 1 credit per MiB');

      // One copy per user: the same account cannot take two jobs of the same content.
      const rewards = { upfront: 1, perRetrieval: 1, perChallenge: 1, completion: 1 };
      const first = provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 2, durationSeconds: 3600, rewards });
      provider.service.createJob({ cid, chunks: manifest.chunks, replicas: 2, durationSeconds: 3600, rewards });
      await user.json(`/v1/services/storage/offers/${first.id}/accept`, { method: 'POST' });
      const second = provider.service.jobs().find((job) => job.cid === cid && job.id !== first.id)!;
      await assert.rejects(user.json(`/v1/services/storage/offers/${second.id}/accept`, { method: 'POST' }), /already store/);

      // A holder who fails to hand back a chunk is eliminated from the job.
      await admin(provider.url(), '/v1/admin/config', { method: 'PUT', body: { storageService: { taskTimeoutSeconds: 1 } } });
      const account = (await user.json<{ account: { id: string } }>('/v1/account')).account;
      const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === first.id)!;
      await user.json(`/v1/services/storage/assignments/${assignment.id}/ready`, { method: 'POST' });
      const fake = { id: account.id } as never;
      await provider.service.poll(fake, 0); // the holder comes online
      assert.equal(await provider.service.retrieve(manifest.chunks[0].id), null, 'no holder answers in time');
      const task = (await provider.service.poll(fake, 0)).find((entry) => entry.type === 'retrieve');
      assert.ok(task);
      await assert.rejects(provider.service.answer(fake, task.id, randomBytesOf(16)), /do not match/);
      assert.equal(provider.service.assignmentsForAdmin().find((entry) => entry.id === assignment.id)?.status, 'failed');

      // Deleting a job takes its assignments with it.
      await admin(provider.url(), `/v1/admin/storage/jobs/${first.id}`, { method: 'DELETE' });
      assert.equal(provider.service.jobs().some((job) => job.id === first.id), false);
      assert.equal(provider.service.assignmentsForAdmin().some((entry) => entry.jobId === first.id), false);
    } finally {
      await provider.stop();
    }
  });

  it('follows the tier with the storage job, tests holders live, and checks endpoints', async () => {
    const provider = await startProvider();
    try {
      const data = randomBytesOf(MiB);
      const { cid, manifest } = await provider.importBuffer(data, { name: 'job.bin' });
      const jobsFor = () => provider.service.jobs().filter((job) => job.cid === cid);

      // Content created → its storage job exists, shaped by the default (bronze) plan.
      assert.equal(jobsFor().length, 1, 'one job follows the tier');
      assert.equal(jobsFor()[0].replicas, 2, 'bronze wants two URL backups');

      // Tier changed → the job is recreated to match the new plan.
      await admin(provider.url(), `/v1/admin/tiers/${cid}`, { method: 'POST', body: { tier: 'gold' } });
      assert.equal(jobsFor().length, 1);
      assert.equal(jobsFor()[0].replicas, 5, 'gold wants two media copies and three URL backups');

      // A live test asks a holder for a real chunk and pays its account the reward.
      const job = jobsFor()[0];
      const user = clientFor(provider.url(), 'identity');
      await user.json(`/v1/services/storage/offers/${job.id}/accept`, { method: 'POST' });
      const assignment = provider.service.assignmentsForAdmin().find((entry) => entry.jobId === job.id)!;
      await user.json(`/v1/services/storage/assignments/${assignment.id}/ready`, { method: 'POST' });
      const account = (await user.json<{ account: { id: string } }>('/v1/account')).account;
      const fake = { id: account.id } as never;
      const testing = provider.service.testJob(job.id, 3);
      const task = (await provider.service.poll(fake, 0)).find((entry) => entry.type === 'retrieve');
      assert.ok(task, 'the test asks a holder for a chunk');
      const index = manifest.chunks.findIndex((chunk) => chunk.id === task.chunkId);
      const start = manifest.chunks.slice(0, index).reduce((sum, chunk) => sum + chunk.size, 0);
      await provider.service.answer(fake, task.id, data.subarray(start, start + manifest.chunks[index].size));
      const result = await testing;
      assert.equal(result.ok, true);
      assert.equal(result.account, account.id);
      assert.equal(result.credited, 3, 'the test pays the holder’s account');

      // Any endpoint can be checked: available, hash-matching bytes pass — the rest fail.
      const server = createServer((req, res) => {
        if (req.url?.includes('/gone/')) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(req.url?.includes('/wrong/') ? randomBytesOf(MiB, 2) : data);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const good = await admin<{ verify: { ok: boolean; bytes: number } }>(provider.url(), `/v1/admin/content/${cid}/verify`, {
          method: 'POST',
          body: { url: `http://127.0.0.1:${port}/files/${cid}` },
        });
        assert.equal(good.verify.ok, true, 'hash-matching bytes pass');
        assert.equal(good.verify.bytes, MiB);
        const wrong = await admin<{ verify: { ok: boolean; error?: string } }>(provider.url(), `/v1/admin/content/${cid}/verify`, {
          method: 'POST',
          body: { url: `http://127.0.0.1:${port}/wrong/${cid}` },
        });
        assert.equal(wrong.verify.ok, false);
        assert.match(wrong.verify.error ?? '', /did not match/);
        const gone = await admin<{ verify: { ok: boolean; error?: string } }>(provider.url(), `/v1/admin/content/${cid}/verify`, {
          method: 'POST',
          body: { url: `http://127.0.0.1:${port}/gone/${cid}` },
        });
        assert.equal(gone.verify.ok, false);
        assert.match(gone.verify.error ?? '', /404/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // The job goes when the content leaves the tiers entirely.
      await admin(provider.url(), `/v1/admin/tiers/${cid}`, { method: 'DELETE' });
      assert.equal(jobsFor().length, 0, 'the storage job goes with the content');
    } finally {
      await provider.stop();
    }
  });
});