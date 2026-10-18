// Saved cids: the user saves any cid and sorts it into their own collections — one
// saved cid may sit in several collections at once, and the collections are theirs to
// make, rename and remove (removing one leaves the saved cids saved).
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { SavedState } from '../src/shared/clientapi.js';
import { startClient, tempDir } from './helpers.js';

describe('saved cids in the user’s own collections', async () => {
  const { dir, cleanup } = tempDir();
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    cleanup();
  });

  it('saves a cid into a collection, making that collection on the spot', async () => {
    const saved = await api<SavedState>('/api/saved', {
      method: 'POST',
      body: { id: 'vs1aaa~yt:one', title: 'Black holes', collections: ['Watch later'] },
    });
    assert.equal(saved.collections.length, 1, 'the named collection is made');
    assert.equal(saved.collections[0].name, 'Watch later');
    assert.deepEqual(
      saved.items.map((item) => item.id),
      ['vs1aaa~yt:one']
    );
    assert.deepEqual(saved.items[0].collections, [saved.collections[0].id], 'saved into that collection');

    // Saving the same cid again keeps one entry and may re-assign it.
    const again = await api<SavedState>('/api/saved', { method: 'POST', body: { id: 'vs1aaa~yt:one', title: 'Black holes' } });
    assert.equal(again.items.length, 1, 'one entry per cid');
  });

  it('assigns a saved cid to different collections — existing and brand new', async () => {
    const assigned = await api<SavedState>(`/api/saved/${encodeURIComponent('vs1aaa~yt:one')}`, {
      method: 'PATCH',
      body: { collections: ['Watch later', 'Science', 'Science'] },
    });
    assert.equal(assigned.collections.length, 2, 'the new collection is made; names are not duplicated');
    const ids = assigned.items[0].collections.slice().sort();
    assert.deepEqual(ids, assigned.collections.map((c) => c.id).sort(), 'the same cid sits in several collections at once');

    const later = assigned.collections.find((c) => c.name === 'Watch later')!;
    const only = await api<SavedState>(`/api/saved/${encodeURIComponent('vs1aaa~yt:one')}`, {
      method: 'PATCH',
      body: { collections: [later.id] },
    });
    assert.deepEqual(only.items[0].collections, [later.id], 'and is taken out of the others again');
  });

  it('makes, renames and removes collections; the saved cids stay saved', async () => {
    const made = await api<SavedState>('/api/cid-collections', { method: 'POST', body: { name: 'Music' } });
    const music = made.collections.find((c) => c.name === 'Music')!;
    const renamed = await api<SavedState>(`/api/cid-collections/${music.id}`, { method: 'PATCH', body: { name: 'Tunes' } });
    assert.ok(renamed.collections.some((c) => c.id === music.id && c.name === 'Tunes'));
    await assert.rejects(api('/api/cid-collections', { method: 'POST', body: { name: 'Tunes' } }), /already/);

    const gone = await api<SavedState>(`/api/cid-collections/${music.id}`, { method: 'DELETE' });
    assert.ok(!gone.collections.some((c) => c.id === music.id), 'the collection is gone');
    assert.equal(gone.items.length, 1, 'the saved cid stays saved');
    assert.ok(!gone.items[0].collections.includes(music.id), 'and just leaves the removed collection');
  });

  it('takes a cid out of the saved list entirely', async () => {
    const empty = await api<SavedState>(`/api/saved/${encodeURIComponent('vs1aaa~yt:one')}`, { method: 'DELETE' });
    assert.deepEqual(
      empty.items.map((item) => item.id),
      []
    );
    assert.ok(empty.collections.length > 0, 'the collections themselves stay');
  });
});