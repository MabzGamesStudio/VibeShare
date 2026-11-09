// Toast messages on the client: kept only while the user turns that on (off by default),
// and searchable and deletable exactly like the watch and search history.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { Settings, ToastMessage } from '../src/shared/clientapi.js';
import { startClient, tempDir } from './helpers.js';

describe('saved toast messages', async () => {
  const { dir, cleanup } = tempDir();
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    cleanup();
  });

  const toasts = () => api<{ items: ToastMessage[] }>('/api/toasts');
  const post = (text: string, kind: string) => api('/api/toasts', { body: { text, kind } });

  it('keeps nothing by default and saves messages once the user turns that on', async () => {
    await post('Before the switch', 'info');
    assert.deepEqual((await toasts()).items, [], 'off by default: not one message is kept');
    await api<Settings>('/api/settings', { method: 'PATCH', body: { toastHistory: true } });
    await post('All good', 'success');
    await post('Something broke', 'error');
    assert.deepEqual(
      (await toasts()).items.map((item) => item.text),
      ['Something broke', 'All good'],
      'newest first, with the kind it was shown with'
    );
  });

  it('searches through the messages and deletes one, or all of them', async () => {
    const found = await api<{ items: ToastMessage[] }>('/api/toasts?q=broke');
    assert.deepEqual(
      found.items.map((item) => item.text),
      ['Something broke'],
      'the same search as the histories above'
    );
    const one = await api<{ items: ToastMessage[] }>(`/api/toasts/${encodeURIComponent(found.items[0].id)}`, { method: 'DELETE' });
    assert.deepEqual(
      one.items.map((item) => item.text),
      ['All good'],
      'one message is gone'
    );
    const all = await api<{ items: ToastMessage[] }>('/api/toasts', { method: 'DELETE' });
    assert.deepEqual(all.items, [], 'and then all of them');
  });

  it('saves nothing more while browsing is paused', async () => {
    await api('/api/settings', { method: 'PATCH', body: { pauseHistory: true } });
    await post('While paused', 'info');
    assert.deepEqual((await toasts()).items, [], 'the pause stands over the toast log too');
    await api('/api/settings', { method: 'PATCH', body: { pauseHistory: false } });
    await post('Back again', 'info');
    assert.deepEqual(
      (await toasts()).items.map((item) => item.text),
      ['Back again']
    );
  });
});