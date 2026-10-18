// The search history: what the search bar suggests from — recorded only while the user
// wants it, listable and clearable on the History page, and paused together with the
// rest of the history when browsing is paused.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { SearchHistoryItem, Settings } from '../src/shared/clientapi.js';
import { startClient, tempDir } from './helpers.js';

describe('the search history', async () => {
  const { dir, cleanup } = tempDir();
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    cleanup();
  });

  const search = (query: string) => api('/api/search', { body: { query } });
  const history = () => api<{ items: SearchHistoryItem[] }>('/api/search-history');

  it('keeps what the user searches for, most recent first and without repeats', async () => {
    await search('black holes');
    await search('nebulae');
    await search('black holes');
    const { items } = await history();
    assert.deepEqual(
      items.map((item) => item.query),
      ['black holes', 'nebulae'],
      'one entry per query; the repeated one moves back to the top'
    );
    assert.ok(items.every((item) => item.at), 'each entry says when it was searched');
  });

  it('lists the past searches the search box matches against', async () => {
    const { items } = await history();
    const matches = items.filter((item) => item.query.toLowerCase().includes('hole'));
    assert.deepEqual(
      matches.map((item) => item.query),
      ['black holes'],
      'matching is by part of the query'
    );
  });

  it('can be turned off — then nothing new is recorded', async () => {
    await api<Settings>('/api/settings', { method: 'PATCH', body: { searchHistory: false } });
    await search('galaxies');
    assert.ok(!(await history()).items.some((item) => item.query === 'galaxies'), 'turned off: no new entries');
    await api<Settings>('/api/settings', { method: 'PATCH', body: { searchHistory: true } });
    await search('galaxies');
    assert.ok((await history()).items.some((item) => item.query === 'galaxies'), 'and back on: recorded again');
  });

  it('suggesting them under the search box is toggled on its own', async () => {
    const settings = await api<Settings>('/api/settings', { method: 'PATCH', body: { searchSuggestions: false } });
    assert.equal(settings.searchSuggestions, false);
    assert.equal(settings.searchHistory, true, 'keeping the history is its own switch');
    await api('/api/settings', { method: 'PATCH', body: { searchSuggestions: true } });
  });

  it('records nothing while browsing is paused', async () => {
    await api('/api/settings', { method: 'PATCH', body: { pauseHistory: true } });
    await search('quiet queries');
    await api('/api/settings', { method: 'PATCH', body: { pauseHistory: false } });
    assert.ok(!(await history()).items.some((item) => item.query === 'quiet queries'), 'the pause leaves no trace');
  });

  it('clears one query, or all of it', async () => {
    const one = await api<{ items: SearchHistoryItem[] }>('/api/search-history', { method: 'DELETE', body: { query: 'black holes' } });
    assert.ok(!one.items.some((item) => item.query === 'black holes'), 'one query is gone');
    assert.ok(one.items.length > 0, 'the rest stays');
    const all = await api<{ items: SearchHistoryItem[] }>('/api/search-history', { method: 'DELETE', body: {} });
    assert.deepEqual(all.items, [], 'and then all of it');
  });
});