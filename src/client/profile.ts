// Profiles, settings and identity: several users of one client, each with their own
// nodes, settings, history and client id (key). Public profiles open for anyone; others
// need their username and password, and a hidden one is encrypted at rest — its sealed
// blob is kept current on every change while it is open. One collaborator of
// ClientCore; browser-safe.
import type { ClientState, ProfileSummary, Settings } from '../shared/clientapi.js';
import { applySettingsPatch, defaultSettings, normalizeSettings } from '../shared/clientdefaults.js';
import { badRequest, notFound } from '../shared/errors.js';
import { log } from '../shared/node/log.js';
import {
  decodeProfileSeed,
  encodeProfileSeed,
  hashProfilePassword,
  newProfileSeed,
  profileSealKey,
  randomProfileSalt,
  sealProfile,
  unsealProfile,
  verifyProfilePassword,
  type ProfileAccess,
  type SealKey,
} from '../shared/profiles.js';
import { emptySavedState, type ProfilePayload, type ProfileRecord } from './model.js';
import { errorText } from './nodes.js';
import type { ClientCore } from './core.js';

/** Profiles, settings and identity, for one client. */
export class Profiles {
  constructor(private readonly core: ClientCore) {}

  updateSettings(patch: Partial<Settings>): Settings {
    const current = this.core.settings;
    let next: Settings;
    try {
      next = applySettingsPatch(current, patch);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    this.core.store.data.data.settings = next;
    this.core.store.changed();
    this.core.options.onSettings?.(current, next);
    this.core.scheduleBloomJob();
    return next;
  }
  // -------------------------------------------------------------------------
  // Profiles: several users of one client, each with their own nodes, settings,
  // history and client id (key). Public profiles open for anyone; others need
  // their username and password.

  /** Makes sure the current data has a profile record (the implicit single profile). */
  private ensureProfiles(): void {
    const data = this.core.store.data.data;
    data.profiles ??= [];
    data.activeProfile ??= 'main';
    if (data.profiles.length) return;
    data.profiles.push({
      id: data.activeProfile || 'main',
      name: this.core.settings.profile.name || 'Main',
      access: { mode: 'public' },
      identitySeed: encodeProfileSeed(this.core.store.identity.seed),
      nodes: data.nodes,
      settings: data.settings,
      subscriptions: data.subscriptions,
      library: data.library,
      history: data.history,
      saved: data.saved ?? emptySavedState(),
      searchHistory: data.searchHistory ?? [],
      toasts: data.toasts ?? [],
      blooms: data.blooms ?? {},
    });
  }

  /** Saves the live data and client id into the active profile's slot. */
  private async snapshotProfile(): Promise<void> {
    const data = this.core.store.data.data;
    this.ensureProfiles();
    const record = data.profiles.find((profile) => profile.id === data.activeProfile);
    if (!record) return;
    const payload: ProfilePayload = {
      name: record.name,
      identitySeed: encodeProfileSeed(this.core.store.identity.seed),
      nodes: data.nodes,
      settings: data.settings,
      subscriptions: data.subscriptions,
      library: data.library,
      history: data.history,
      saved: data.saved ?? emptySavedState(),
      searchHistory: data.searchHistory ?? [],
      toasts: data.toasts ?? [],
      blooms: data.blooms ?? {},
    };
    if (record.hidden) {
      // A hidden profile is only ever stored sealed; the plaintext fields are emptied.
      const key = this.sealKeys.get(record.id);
      if (key) record.sealed = await sealProfile(payload, key);
      record.name = '';
      record.identitySeed = '';
      record.nodes = [];
      record.settings = defaultSettings();
      record.subscriptions = [];
      record.library = [];
      record.history = [];
      record.saved = emptySavedState();
      record.searchHistory = [];
      record.toasts = [];
      record.blooms = {};
      void this.core.store.hideIdentity?.();
    } else {
      record.identitySeed = payload.identitySeed;
      record.nodes = payload.nodes;
      record.settings = payload.settings;
      record.subscriptions = payload.subscriptions;
      record.library = payload.library;
      record.history = payload.history;
      record.saved = payload.saved;
      record.searchHistory = payload.searchHistory;
      record.toasts = payload.toasts ?? [];
      record.blooms = payload.blooms;
    }
  }

  /** The payload of a profile: from its fields, or from its sealed blob when hidden. */
  private payloadOf(record: ProfileRecord): ProfilePayload {
    return {
      name: record.name,
      identitySeed: record.identitySeed,
      nodes: record.nodes,
      settings: record.settings,
      subscriptions: record.subscriptions,
      library: record.library,
      history: record.history,
      saved: record.saved ?? emptySavedState(),
      searchHistory: record.searchHistory ?? [],
      toasts: record.toasts ?? [],
      blooms: record.blooms ?? {},
    };
  }

  /** Loads a profile's payload into the live fields and takes its client id. */
  private loadProfile(record: ProfileRecord, payload: ProfilePayload, previousSettings: Settings): void {
    const data = this.core.store.data.data;
    record.name = payload.name;
    record.identitySeed = payload.identitySeed;
    record.nodes = payload.nodes;
    record.settings = payload.settings;
    record.subscriptions = payload.subscriptions;
    record.library = payload.library;
    record.history = payload.history;
    record.saved = payload.saved ?? emptySavedState();
    record.searchHistory = payload.searchHistory ?? [];
    record.toasts = payload.toasts ?? [];
    record.blooms = payload.blooms ?? {};
    data.nodes = payload.nodes;
    data.settings = normalizeSettings(payload.settings);
    data.subscriptions = payload.subscriptions;
    data.library = payload.library;
    data.history = payload.history;
    data.saved = payload.saved ?? emptySavedState();
    data.searchHistory = payload.searchHistory ?? [];
    data.toasts = payload.toasts ?? [];
    data.blooms = payload.blooms ?? {};
    data.activeProfile = record.id;
    this.core.blooms.reloaded();
    this.core.store.replaceIdentity(decodeProfileSeed(payload.identitySeed));
    this.core.store.changed();
    this.core.options.onSettings?.(previousSettings, data.settings);
    void Promise.all(this.core.nodes.list().map((entry) => this.core.nodes.refreshBalance(entry)));
  }

  /** Keys of hidden profiles opened in this session (kept in memory only). */
  private sealKeys = new Map<string, SealKey>();
  private sealTimer: ReturnType<typeof setTimeout> | null = null;

  /** Keeps the sealed blob of an active hidden profile current on every change. */
  scheduleSeal(): void {
    const data = this.core.store.data.data;
    const record = data.profiles?.find((profile) => profile.id === data.activeProfile && profile.hidden);
    if (!record || !this.sealKeys.has(record.id) || this.sealTimer) return;
    this.sealTimer = setTimeout(() => {
      this.sealTimer = null;
      void this.sealActive(record).catch((error) => log.debug(`Could not seal the hidden profile: ${errorText(error)}`));
    }, 25);
  }

  private async sealActive(record: ProfileRecord): Promise<void> {
    const key = this.sealKeys.get(record.id);
    if (!key) return;
    const data = this.core.store.data.data;
    record.sealed = await sealProfile(
      {
        name: record.name,
        identitySeed: encodeProfileSeed(this.core.store.identity.seed),
        nodes: data.nodes,
        settings: data.settings,
        subscriptions: data.subscriptions,
        library: data.library,
        history: data.history,
        saved: data.saved ?? emptySavedState(),
        searchHistory: data.searchHistory ?? [],
        toasts: data.toasts ?? [],
        blooms: data.blooms ?? {},
      },
      key
    );
    void this.core.store.hideIdentity?.();
  }

  /** True while a hidden profile is active but still sealed (locked). */
  isLocked(): boolean {
    const data = this.core.store.data.data;
    const record = (data.profiles ?? []).find((profile) => profile.id === data.activeProfile && profile.hidden);
    return Boolean(record && (record.sealed || record.hidden) && !this.sealKeys.has(record.id));
  }

  profileSummaries(): ProfileSummary[] {
    const data = this.core.store.data.data;
    const profiles = data.profiles ?? [];
    if (!profiles.length) {
      return [{ id: data.activeProfile || 'main', name: this.core.settings.profile.name || 'Main', access: 'public', active: true }];
    }
    const out: ProfileSummary[] = [];
    for (const profile of profiles) {
      const active = profile.id === data.activeProfile;
      if (profile.hidden) {
        // Hidden profiles do not appear in the list at all. When one is active the
        // client shows only that it is inside one, never its name.
        if (active) out.push({ id: profile.id, name: 'Hidden profile', access: 'protected', hidden: true, active: true });
        continue;
      }
      out.push({
        id: profile.id,
        name: profile.name,
        access: profile.access.mode === 'password' ? 'protected' : 'public',
        username: profile.access.mode === 'password' ? profile.access.username : undefined,
        active,
      });
    }
    return out;
  }

  /** Creates a fresh profile (default settings, no nodes, its own client id). */
  async createProfile(body: { name?: string; username?: string; password?: string; hidden?: boolean }): Promise<ProfileSummary[]> {
    const data = this.core.store.data.data;
    await this.snapshotProfile();
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) throw badRequest('A profile name is required');
    const hidden = Boolean(body.hidden);
    const username = String(body.username ?? '').trim().slice(0, 60);
    const password = String(body.password ?? '');
    if (hidden && (!username || !password)) throw badRequest('A hidden profile needs a username and a password');
    if (!hidden && data.profiles.some((profile) => !profile.hidden && profile.name.toLowerCase() === name.toLowerCase())) {
      throw badRequest('There is already a profile with that name');
    }
    let access: ProfileAccess = { mode: 'public' };
    if (password) {
      if (!username) throw badRequest('A username is needed with a password');
      const salt = randomProfileSalt();
      access = { mode: 'password', username, salt, hash: await hashProfilePassword(password, salt, username) };
    }
    const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const payload: ProfilePayload = {
      name,
      identitySeed: encodeProfileSeed(newProfileSeed()),
      nodes: [],
      settings: defaultSettings(),
      subscriptions: [],
      library: [],
      history: [],
      saved: emptySavedState(),
      searchHistory: [],
      toasts: [],
      blooms: {},
    };
    if (hidden) {
      // A hidden profile is created sealed: its name, client id and data are encrypted
      // with a key derived from the password, and it never appears in the profile list.
      const keySalt = randomProfileSalt();
      const key = await profileSealKey(password, keySalt);
      (access as { keySalt?: string }).keySalt = keySalt;
      data.profiles.push({
        id,
        name: '',
        access,
        hidden: true,
        sealed: await sealProfile(payload, key),
        identitySeed: '',
        nodes: [],
        settings: defaultSettings(),
        subscriptions: [],
        library: [],
        history: [],
        saved: emptySavedState(),
        searchHistory: [],
        toasts: [],
        blooms: {},
      });
    } else {
      data.profiles.push({ ...payload, id, name, access });
    }
    this.core.store.changed();
    return this.profileSummaries();
  }

  /** Switches to another profile: its data, its client id, its node accounts. */
  async switchProfile(body: { id?: string; username?: string; password?: string }): Promise<ClientState> {
    const data = this.core.store.data.data;
    this.ensureProfiles();
    const target = data.profiles.find((profile) => profile.id === String(body.id ?? ''));
    if (!target) throw notFound('No such profile');
    // A hidden profile that is active but still sealed is opened in place.
    if (target.id !== data.activeProfile || (target.hidden && !this.sealKeys.has(target.id))) {
      const password = String(body.password ?? '');
      if (target.access.mode === 'password') {
        const ok = await verifyProfilePassword(target.access, String(body.username ?? ''), password);
        if (!ok) throw badRequest('Wrong username or password for this profile');
      }
      let payload: ProfilePayload;
      if (target.hidden) {
        // A hidden profile opens only with its username and password: the key derived
        // from the password decrypts its data (nothing else can read it).
        if (target.access.mode !== 'password' || !target.sealed) throw badRequest('This hidden profile cannot be opened');
        const key = await profileSealKey(password, target.access.keySalt ?? target.access.salt);
        try {
          payload = await unsealProfile<ProfilePayload>(target.sealed, key);
        } catch {
          throw badRequest('Wrong username or password for this profile');
        }
        await this.snapshotProfile();
        this.sealKeys.set(target.id, key);
      } else {
        await this.snapshotProfile();
        payload = this.payloadOf(target);
      }
      for (const id of [...this.sealKeys.keys()]) if (id !== target.id) this.sealKeys.delete(id);
      this.loadProfile(target, payload, data.settings);
    }
    return this.core.state();
  }

  /** Opens a hidden profile: the only way in is its username and password. */
  async unlockHidden(body: { username?: string; password?: string }): Promise<ClientState> {
    const data = this.core.store.data.data;
    const username = String(body.username ?? '');
    const target = (data.profiles ?? []).find(
      (profile) => profile.hidden && profile.access.mode === 'password' && profile.access.username === username
    );
    if (!target) throw badRequest('Wrong username or password for a hidden profile');
    return this.switchProfile({ id: target.id, username, password: String(body.password ?? '') });
  }

  /** Renames a profile and changes or clears its username/password protection. */
  async updateProfile(body: { id?: string; name?: string; username?: string; password?: string; makePublic?: boolean }): Promise<ProfileSummary[]> {
    const data = this.core.store.data.data;
    this.ensureProfiles();
    const target = data.profiles.find((profile) => profile.id === String(body.id ?? ''));
    if (!target) throw notFound('No such profile');
    if (target.hidden) throw badRequest('A hidden profile is managed only through its unlock dialog');
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 60);
      if (!name) throw badRequest('A profile name is required');
      target.name = name;
    }
    if (body.makePublic) target.access = { mode: 'public' };
    if (body.password) {
      const username = String(body.username ?? (target.access.mode === 'password' ? target.access.username : '')).trim().slice(0, 60);
      if (!username) throw badRequest('A username is needed with a password');
      const salt = randomProfileSalt();
      target.access = { mode: 'password', username, salt, hash: await hashProfilePassword(String(body.password), salt, username) };
    }
    this.core.store.changed();
    return this.profileSummaries();
  }

  /** Deletes a profile, but only with its username and password (typed confirmation for a public profile). */
  async deleteProfile(id: string, credentials: { username?: string; password?: string }): Promise<ProfileSummary[]> {
    const data = this.core.store.data.data;
    this.ensureProfiles();
    const target = data.profiles.find((profile) => profile.id === id);
    if (!target) throw notFound('No such profile');
    const username = String(credentials.username ?? '');
    const password = String(credentials.password ?? '');
    if (!username || !password) throw badRequest('Enter the profile username and password to delete it');
    if (target.access.mode === 'password') {
      // A protected (or hidden) profile is deleted only with its own username and password.
      const ok = await verifyProfilePassword(target.access, username, password);
      if (!ok) throw badRequest('Wrong username or password for this profile');
    } else if (username !== target.name) {
      // A public profile has no password of its own: its name is typed as the username
      // and the password field confirms the intent to delete.
      throw badRequest('Type the profile name as the username to confirm deletion');
    }
    if (id === data.activeProfile) {
      // Deleting the active profile (an anonymous account is deleted this way): switch to
      // another one first. When it is the only profile, wipe it and start clean instead of
      // leaving the client with none.
      const other = data.profiles.find((profile) => profile.id !== id && !profile.hidden);
      if (other) {
        this.loadProfile(other, this.payloadOf(other), data.settings);
      } else {
        const previousSettings = data.settings;
        const freshSettings = defaultSettings();
        const fresh: ProfilePayload = {
          name: freshSettings.profile.name || 'Main',
          identitySeed: encodeProfileSeed(newProfileSeed()),
          nodes: [],
          settings: freshSettings,
          subscriptions: [],
          library: [],
          history: [],
          saved: emptySavedState(),
          searchHistory: [],
          toasts: [],
          blooms: {},
        };
        // The fresh start is an ordinary public profile (drop any hidden/locked state).
        target.hidden = undefined;
        target.access = { mode: 'public' };
        target.sealed = undefined;
        this.sealKeys.delete(target.id);
        this.loadProfile(target, fresh, previousSettings);
        return this.profileSummaries();
      }
    }
    const before = data.profiles.length;
    data.profiles = data.profiles.filter((profile) => profile.id !== id);
    if (data.profiles.length === before) throw notFound('No such profile');
    this.sealKeys.delete(id);
    this.core.store.changed();
    return this.profileSummaries();
  }
  /** Replaces the identity (restoring a backup); sessions are re-opened with the new keys. */
  restoreIdentity(seed: Uint8Array): { id: string } {
    this.core.store.replaceIdentity(seed);
    this.core.nodes.resetSessions();
    void Promise.all(this.core.nodes.list().map((entry) => this.core.nodes.refreshBalance(entry)));
    return { id: this.core.store.identity.id };
  }
}
