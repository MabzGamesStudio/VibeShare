// The client daemon's trace log: the /api/tracing API, the single-event recorder the
// GUI's user actions post to, and how `x-vs-trace` joins one action with the API calls
// it makes. Tracing is off by default, so every test turns it on first.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startClient, tempDir } from '../helpers.js';

describe('the client daemon trace log', () => {
  it('records user actions and joins the API calls they make into one timeline', async () => {
    const { dir, cleanup } = tempDir();
    const { client, api } = await startClient(join(dir, 'client'));
    try {

      // Off by default: nothing at all is recorded until the settings say so.
      const before = await api<{ settings: { enabled: boolean } }>('/api/tracing/settings');
      assert.equal(before.settings.enabled, false);
      const empty = await api<{ total: number }>('/api/tracing/events');
      assert.equal(empty.total, 0);

      // Tracing needs the local token like every other /api route.
      const refused = await fetch(`${client.url()}/api/tracing/events`, { method: 'POST' });
      assert.equal(refused.status, 403);

      const saved = await api<{ settings: { enabled: boolean; levels: Record<string, boolean> } }>('/api/tracing/settings', {
        method: 'PUT',
        body: { enabled: true, levels: { detail: true } },
      });
      assert.equal(saved.settings.enabled, true);
      assert.equal(saved.settings.levels.detail, true);
      // The settings are saved through the client settings like every other setting.
      const state = await api<{ settings: { tracing: { enabled: boolean; levels: Record<string, boolean> } } }>('/api/state');
      assert.equal(state.settings.tracing.enabled, true);
      assert.equal(state.settings.tracing.levels.detail, true);

      // One GUI user action: a detail event under its own trace id.
      const action = 'click:Save';
      await api('/api/tracing/events', {
        body: { level: 'detail', component: 'gui', action, traceId: 'action-1', initiator: { kind: 'user-action', label: action } },
      });
      // The API call the action made joins it (the GUI sends x-vs-trace).
      await api('/api/state', { headers: { 'x-vs-trace': 'action-1' } });

      const timelines = await api<{ timelines: { traceId: string; initiator?: { kind: string; label: string }; events: { action: string }[] }[]; total: number }>(
        '/api/tracing/timelines'
      );
      const joined = timelines.timelines.find((timeline) => timeline.traceId === 'action-1');
      assert.ok(joined, 'the action and its API call share one timeline');
      assert.equal(joined.initiator?.kind, 'user-action');
      assert.equal(joined.initiator?.label, action);
      assert.ok(joined.events.some((event) => event.action.includes('/api/state')), 'the request is part of the timeline');

      const byTrace = await api<{ events: { action: string }[]; total: number }>('/api/tracing/events?traceId=action-1');
      assert.equal(byTrace.total, joined.events.length);

      const cleared = await api<{ cleared: number }>('/api/tracing/events', { method: 'DELETE' });
      assert.ok(cleared.cleared > 0);
    } finally {
      await client.stop();
      cleanup();
    }
  });
});