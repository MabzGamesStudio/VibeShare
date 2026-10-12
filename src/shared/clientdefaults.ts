// Default client settings, preset pages and helpers shared by the desktop/CLI client
// and the static web client. Browser-safe: no Node imports.
import type { PageConfig, PageFilters, PagePreset, Settings } from './clientapi.js';
import type { Preferences } from './protocol.js';
import { baseLanguage } from './language.js';
import { RATINGS, type Rating } from './taxonomy.js';

/** Where shared links point unless the user (or the web build) configures another hosted client. */
export const DEFAULT_SHARE_BASE_URL = 'https://mabzgamesstudio.github.io/WebPages/pages/vibeShare/web';
/** Earlier defaults, moved to the current one when settings are loaded. */
const OLD_SHARE_BASE_URLS = ['https://mabzgamesstudio.github.io/webpages/vibeshare'];

const NO_FILTERS: PageFilters = { formats: [], topics: [], onlyTopics: false, creatorKinds: [] };

export function presetPage(preset: PagePreset): PageConfig {
  switch (preset) {
    case 'videos':
      return {
        id: 'videos',
        title: 'Videos',
        icon: 'film',
        preset,
        layout: 'grid',
        source: 'feed',
        filters: { ...NO_FILTERS, formats: ['video', 'live'] },
        thumbnail: true,
        fields: ['title', 'creator', 'published'],
        options: { autoplay: false, muted: true, columns: 0, size: 'large' },
        sidebar: true,
      };
    case 'shorts':
      return {
        id: 'shorts',
        title: 'Shorts',
        icon: 'smartphone',
        preset,
        layout: 'shorts',
        source: 'feed',
        filters: { ...NO_FILTERS, formats: ['short-video'] },
        thumbnail: true,
        fields: ['title', 'creator', 'likes', 'platform'],
        options: { autoplay: true, muted: true, columns: 1, size: 'large' },
        sidebar: true,
      };
    case 'images':
      return {
        id: 'images',
        title: 'Images',
        icon: 'image',
        preset,
        layout: 'stream',
        source: 'feed',
        filters: { ...NO_FILTERS, formats: ['image'] },
        thumbnail: true,
        fields: ['title', 'creator', 'platform'],
        options: { autoplay: false, muted: true, columns: 1, size: 'large' },
        sidebar: true,
      };
  }
}

export const PRESETS: PagePreset[] = ['videos', 'shorts', 'images'];

export function defaultPages(): PageConfig[] {
  return PRESETS.map(presetPage);
}

/** Current settings format; older settings get the newer defaults once (normalizeSettings). */
export const SETTINGS_REVISION = 2;

export function defaultSettings(): Settings {
  return {
    revision: SETTINGS_REVISION,
    pages: defaultPages(),
    shareBaseUrl: DEFAULT_SHARE_BASE_URL,
    preferences: { maxRating: '16+', formats: [], topics: [], blockedTags: [], blockedCreators: [], creatorKinds: [], languages: ['en'] },
    feedMode: 'blend',
    unknownContent: 'warn',
    defaultAuth: 'pseudonym',
    autoplay: true,
    loadPauseMs: 1500,
    cacheMiB: 1024,
    ipfsGateway: 'https://ipfs.io',
    profile: { name: '', kind: 'person' },
    storageService: { enabled: false, quotaGiB: 5, providers: [] },
    theme: 'system',
    tor: { mode: 'onion', proxy: '' },
  };
}

/** Fills in what older or partial settings miss, and keeps every preset page present. */
export function normalizeSettings(saved: Partial<Settings> | undefined, base: Settings = defaultSettings()): Settings {
  const merged: Settings = {
    ...base,
    ...saved,
    preferences: { ...base.preferences, ...saved?.preferences },
    profile: { ...base.profile, ...saved?.profile },
    storageService: { ...base.storageService, ...saved?.storageService },
    tor: { ...base.tor, ...saved?.tor },
  };
  // The old default home page (a 2D canvas) is gone: the video page is the home page now.
  const goneHome = (page: { id: string; preset?: string }) => page.id === 'home' || page.preset === 'home';
  const pages = (Array.isArray(saved?.pages) && saved.pages.length ? saved.pages : base.pages)
    .filter((page) => !goneHome(page))
    .map((page) => normalizePage(page));
  for (const preset of PRESETS) {
    if (!pages.some((page) => page.id === preset)) pages.push(presetPage(preset));
  }
  merged.pages = pages;
  if (!merged.shareBaseUrl || OLD_SHARE_BASE_URLS.includes(merged.shareBaseUrl.replace(/\/+$/, '').toLowerCase())) merged.shareBaseUrl = base.shareBaseUrl;
  if (saved && (saved.revision ?? 1) < 2) {
    // Revision 2: titles are filtered by language, English only unless the user picked languages.
    if (!saved.preferences?.languages?.length) merged.preferences.languages = [...(base.preferences.languages ?? [])];
  }
  merged.revision = SETTINGS_REVISION;
  return merged;
}

export function normalizePage(page: Partial<PageConfig> & { id: string }): PageConfig {
  const preset = page.preset as string | undefined;
  const template = preset && preset !== 'home' ? presetPage(preset as PagePreset) : presetPage('videos');
  return {
    ...template,
    ...page,
    preset: page.preset,
    filters: { ...NO_FILTERS, ...(preset ? template.filters : {}), ...page.filters },
    options: { ...template.options, ...page.options },
    fields: Array.isArray(page.fields) ? page.fields : template.fields,
  } as PageConfig;
}

function lowerRating(a: Rating | undefined, b: Rating | undefined): Rating | undefined {
  if (!a) return b;
  if (!b) return a;
  return RATINGS[Math.min(RATINGS.indexOf(a), RATINGS.indexOf(b))];
}

/**
 * The preferences sent to algorithm nodes for a page: the user's preferences, narrowed by
 * the page's filters. A page can never raise the user's age rating limit.
 */
export function pagePreferences(preferences: Preferences, filters: Partial<PageFilters> | undefined): Preferences {
  if (!filters) return preferences;
  const out: Preferences = { ...preferences };
  if (filters.formats?.length) out.formats = filters.formats;
  if (filters.topics?.length) {
    out.topics = filters.topics;
    out.onlyTopics = Boolean(filters.onlyTopics);
  }
  if (filters.creatorKinds?.length) out.creatorKinds = filters.creatorKinds;
  out.maxRating = lowerRating(preferences.maxRating, filters.maxRating);
  return out;
}

/** The link that opens a content id in a hosted web client (hash router). */
export function shareLink(baseUrl: string, contentId: string, providerHint?: string): string {
  const base = (baseUrl || DEFAULT_SHARE_BASE_URL).replace(/\/+$/, '').replace(/\/(index\.html)?#.*$/, '');
  const hint = providerHint ? `?p=${encodeURIComponent(providerHint)}` : '';
  return `${base}/#/watch/${encodeURIComponent(contentId)}${hint}`;
}

/** A short random id for a new page. */
export function newPageId(): string {
  return `p-${Math.random().toString(36).slice(2, 10)}`;
}

const LAYOUTS = ['canvas', 'grid', 'list', 'shorts', 'stream', 'masonry'];
const SOURCES = ['feed', 'search', 'subscriptions'];

/**
 * Applies a settings change, checking every value. Throws an Error whose message is
 * meant for the user when something is invalid.
 */
export function applySettingsPatch(current: Settings, patch: Partial<Settings>): Settings {
  const next = normalizeSettings({
    ...current,
    ...patch,
    preferences: { ...current.preferences, ...(patch.preferences ?? {}) },
    profile: { ...current.profile, ...(patch.profile ?? {}) },
    storageService: { ...current.storageService, ...(patch.storageService ?? {}) },
    tor: { ...current.tor, ...(patch.tor ?? {}) },
    pages: patch.pages ?? current.pages,
  });
  if (!['off', 'onion', 'all'].includes(next.tor.mode)) throw new Error('Tor mode is off, onion or all');
  next.tor.proxy = String(next.tor.proxy ?? '').trim();
  if (next.tor.proxy && !/^(socks5h?:\/\/)?(\[[0-9a-f:.]+\]|[\w.-]+)(:\d{1,5})?\/?$/i.test(next.tor.proxy)) {
    throw new Error('The Tor address is host:port, e.g. 127.0.0.1:9050');
  }
  if (!['blend', 'primary'].includes(next.feedMode)) throw new Error('feedMode is blend or primary');
  if (!['warn', 'hide', 'allow'].includes(next.unknownContent)) throw new Error('unknownContent is warn, hide or allow');
  next.cacheMiB = Math.max(16, Number(next.cacheMiB) || 1024);
  next.loadPauseMs = Math.min(10_000, Math.max(0, Math.round(Number(next.loadPauseMs) || 0)));
  const languages = Array.isArray(next.preferences.languages) ? next.preferences.languages : [];
  next.preferences.languages = [...new Set(languages.map((code) => baseLanguage(String(code))).filter((code) => /^[a-z]{2,3}$/.test(code)))].slice(0, 30);
  next.storageService.quotaGiB = Math.max(0, Number(next.storageService.quotaGiB) || 0);
  try {
    const url = new URL(next.shareBaseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    next.shareBaseUrl = next.shareBaseUrl.replace(/\/+$/, '');
  } catch {
    throw new Error('The share link address must be an http(s) URL');
  }
  if (next.pages.length > 50) throw new Error('At most 50 pages');
  const ids = new Set<string>();
  for (const page of next.pages) {
    if (!/^[a-z0-9-]{1,40}$/.test(page.id) || ids.has(page.id)) throw new Error(`Bad or duplicate page id ${page.id}`);
    ids.add(page.id);
    page.title = String(page.title ?? '').trim().slice(0, 40) || 'Untitled';
    if (!LAYOUTS.includes(page.layout)) throw new Error(`Unknown layout ${page.layout}`);
    if (!SOURCES.includes(page.source)) throw new Error(`Unknown content source ${page.source}`);
    if (page.query !== undefined) page.query = String(page.query).slice(0, 200);
    page.fields = [...new Set(page.fields)].slice(0, 20);
    page.options.columns = Math.min(8, Math.max(0, Math.round(Number(page.options.columns) || 0)));
    if (!['small', 'medium', 'large'].includes(page.options.size)) page.options.size = 'medium';
    if (page.filters.maxRating && !RATINGS.includes(page.filters.maxRating)) delete page.filters.maxRating;
  }
  return next;
}
