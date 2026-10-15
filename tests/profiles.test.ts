// Profiles: several users of one client, each with their own nodes, settings, history
// and client id. Public profiles switch freely; protected ones need username + password.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ClientState, ProfileSummary } from '../src/shared/clientapi.js';
import { startClient, tempDir } from './helpers.js';

describe('client profiles', async () => {
  const { dir, cleanup } = tempDir();
  const { api, client } = await startClient(dir);
  after(async () => {
    await client.stop();
    cleanup();
  });

  it('keeps each profile apart and protects it with a password', async () => {
    const initial = await api<ClientState>('/api/state');
    assert.equal(initial.profiles.length, 1, 'one implicit profile to start with');
    assert.equal(initial.profiles[0].access, 'public');
    const mainId = initial.activeProfile;

    await api('/api/profiles', { body: { name: 'Work', username: 'ann', password: 's3cret' } });
    const listed = await api<{ profiles: ProfileSummary[] }>('/api/profiles');
    assert.equal(listed.profiles.length, 2);
    const work = listed.profiles.find((profile) => profile.name === 'Work')!;
    assert.equal(work.access, 'protected');
    assert.equal(work.username, 'ann');
    assert.equal(work.active, false);

    // A protected profile does not open without its username and password.
    await assert.rejects(api(`/api/profiles/${work.id}/switch`, { method: 'POST', body: {} }), /Wrong username or password/);
    await assert.rejects(
      api(`/api/profiles/${work.id}/switch`, { method: 'POST', body: { username: 'ann', password: 'wrong' } }),
      /Wrong username or password/
    );

    const asWork = await api<ClientState>(`/api/profiles/${work.id}/switch`, {
      method: 'POST',
      body: { username: 'ann', password: 's3cret' },
    });
    assert.equal(asWork.activeProfile, work.id);
    assert.notEqual(asWork.identity.id, initial.identity.id, 'every profile has its own client id');

    // Work's own settings and history.
    await api('/api/settings', { method: 'PATCH', body: { theme: 'dark' } });
    await api('/api/history', { body: { id: 'yt:some-video', title: 'Watched at work' } });

    // Back to the public profile: its data is untouched.
    const asMain = await api<ClientState>(`/api/profiles/${mainId}/switch`, { method: 'POST', body: {} });
    assert.equal(asMain.identity.id, initial.identity.id, 'switching back restores the profile’s client id');
    assert.equal(asMain.settings.theme, 'system');
    const mainLibrary = await api<{ history: { id: string }[] }>('/api/library');
    assert.equal(mainLibrary.history.length, 0, 'history is kept per profile');

    // And Work's data comes back when it is unlocked again.
    const backToWork = await api<ClientState>(`/api/profiles/${work.id}/switch`, {
      method: 'POST',
      body: { username: 'ann', password: 's3cret' },
    });
    assert.equal(backToWork.settings.theme, 'dark');
    const workLibrary = await api<{ history: { id: string }[] }>('/api/library');
    assert.deepEqual(workLibrary.history.map((item) => item.id), ['yt:some-video']);
    assert.equal(backToWork.identity.id, asWork.identity.id);
  });

  it('renames, protects and deletes profiles', async () => {
    const listed = await api<{ profiles: ProfileSummary[] }>('/api/profiles');
    const work = listed.profiles.find((profile) => profile.name === 'Work')!;
    const main = listed.profiles.find((profile) => profile.active)!;

    await api(`/api/profiles/${work.id}`, { method: 'PATCH', body: { name: 'Office' } });
    await api(`/api/profiles/${work.id}`, { method: 'PATCH', body: { makePublic: true } });
    const renamed = await api<{ profiles: ProfileSummary[] }>('/api/profiles');
    const office = renamed.profiles.find((profile) => profile.id === work.id)!;
    assert.equal(office.name, 'Office');
    assert.equal(office.access, 'public');

    await api('/api/profiles', { body: { name: 'Temp' } });
    const withTemp = await api<{ profiles: ProfileSummary[] }>('/api/profiles');
    const temp = withTemp.profiles.find((profile) => profile.name === 'Temp')!;
    await api(`/api/profiles/${temp.id}`, { method: 'DELETE' });
    const afterDelete = await api<{ profiles: ProfileSummary[] }>('/api/profiles');
    assert.equal(afterDelete.profiles.length, 2);

    // The active profile cannot be deleted.
    await assert.rejects(api(`/api/profiles/${main.id}`, { method: 'DELETE' }), /Switch to another profile/);
  });
});