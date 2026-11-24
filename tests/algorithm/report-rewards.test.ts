// Reporting content pays for genuinely new information only: a content the node
// already knows — whatever shape its entry carries it in — earns nothing.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { clientFor, startAlgorithm } from '../helpers.js';

describe('reporting content the node already knows', async () => {
  const algorithm = await startAlgorithm({ name: 'Knowing node' });
  after(async () => {
    await algorithm.stop();
  });

  const report = (id: string) => clientFor(algorithm.url()).json<{ known: boolean; credited: number }>('/v1/reports', { body: { id } });

  it('pays nothing for the id the node already has as the entry id', async () => {
    algorithm.registry.upsert({ id: 'yt:legacy-one', status: 'listed' });
    // A minimal entry whose id is the link itself and carries no separate link field.
    delete (algorithm.registry.data.entries['yt:legacy-one'] as { link?: string }).link;
    const before = algorithm.registry.all().length;

    assert.deepEqual(await report('yt:legacy-one'), { known: true, credited: 0 }, 'the entry id is the link — known already');
    assert.equal(algorithm.registry.all().length, before, 'no duplicate entry was created');
  });

  it('pays for genuinely unknown content', async () => {
    assert.deepEqual(await report('yt:brand-new-two'), { known: false, credited: 2 });
    assert.deepEqual(await report('yt:brand-new-two'), { known: true, credited: 0 }, 'the second time it is known');
  });

  it('pays nothing for a link already among the entry sources', async () => {
    algorithm.registry.upsert({ id: `vs1${'d'.repeat(52)}`, sources: ['yt:in-sources'], status: 'listed' });
    const before = algorithm.registry.all().length;

    assert.deepEqual(await report('yt:in-sources'), { known: true, credited: 0 }, 'the source already carries the link');
    assert.equal(algorithm.registry.all().length, before, 'no duplicate entry was created');
    assert.equal(algorithm.registry.all().some((entry) => entry.id === 'yt:in-sources'), false);
  });
});
