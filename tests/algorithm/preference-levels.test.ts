// Formats a reader excluded outright and the language slider's strength: the algorithm
// must drop excluded formats, and only hard-filter languages at the "only show" level
// (weaker levels are ranking hints, not exclusions).
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { startAlgorithm } from '../helpers.js';

describe('preference levels', async () => {
  const algorithm = await startAlgorithm();
  after(() => algorithm.stop());

  algorithm.registry.upsert({ id: 'vs1' + 'a'.repeat(52), title: 'A picture', format: 'image', rating: 'all', language: 'en', status: 'listed' });
  algorithm.registry.upsert({ id: 'vs1' + 'b'.repeat(52), title: 'A video', format: 'video', rating: 'all', language: 'fr', status: 'listed' });

  const feed = async (preferences: Record<string, unknown>) => {
    const user = await import('../helpers.js').then((helpers) => helpers.clientFor(algorithm.url(), 'identity'));
    const page = await user.json<{ items: { id: string }[] }>('/v1/feed', { body: { preferences } });
    return page.items.map((item) => item.id.split('~')[0]);
  };

  it('drops formats the reader excluded (the tri-state red state)', async () => {
    const ids = await feed({ blockedFormats: ['image'] });
    assert.ok(!ids.includes('vs1' + 'a'.repeat(52)), 'the excluded image is gone');
    assert.ok(ids.includes('vs1' + 'b'.repeat(52)), 'the other format stays');
  });

  it('hard-filters languages only at "only show"', async () => {
    const only = await feed({ languages: ['fr'], languageLevel: 'only' });
    assert.ok(!only.includes('vs1' + 'a'.repeat(52)), 'only-show keeps just the chosen language');
    const hinted = await feed({ languages: ['fr'], languageLevel: 'suggest' });
    assert.ok(hinted.includes('vs1' + 'a'.repeat(52)), 'a weaker level does not hide other languages');
  });
});
