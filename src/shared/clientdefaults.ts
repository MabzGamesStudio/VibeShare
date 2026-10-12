// Default client settings, preset pages and helpers shared by the desktop/CLI client
// and the static web client. Browser-safe: no Node imports.
import type { PageConfig, PageFilters, PagePreset, Settings } from './clientapi.js';
import type { Preferences } from './protocol.js';
import { RATINGS, type Rating } from './taxonomy.js';

/** Where shared links point unless the user (or the web build) configures another hosted client. */
export const DEFAULT_SHARE_BASE_URL = 'https://MabzGamesStudio.github.io/WebPages/VibeShare';

const NO_FILTERS: PageFilters = { formats: [], topics: [], onlyTopics: false, creatorKinds: [] };

export function presetPage(preset: PagePreset): PageConfig {
  switch (preset) {
    case 'home':
      return {
        id: 'home',
        title: 'Home',
        icon: 'home',
        preset,
        layout: 'canvas',
        source: 'feed',
        filters: { ...NO_FILTERS },
        thumbnail: true,
        fields: ['title', 'creator'],
        options: { autoplay: false, muted: true, columns: 0, size: 'medium' },
        sidebar: true,
      };
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
        fields: ['title', 'creator', 'platform'],
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

export const PRESETS: PagePreset[] = ['home', 'videos', 'shorts', 'images'];

export function defaultPages(): PageConfig[] {
  return PRESETS.map(presetPage);
}

export function defaultSettings(): Settings {
  return {
    pages: defaultPages(),
    shareBaseUrl: DEFAULT_SHARE_BASE_URL,
    preferences: { maxRating: '16+', formats: [], topics: [], blockedTags: [], blockedCreators: [], creatorKinds: [], languages: [] },
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
  };
  const pages = Array.isArray(saved?.pages) && saved.pages.length ? saved.pages.map((page) => normalizePage(page)) : base.pages;
  for (const preset of PRESETS) {
    if (!pages.some((page) => page.id === preset)) pages.push(presetPage(preset));
  }
  merged.pages = pages;
  if (!merged.shareBaseUrl) merged.shareBaseUrl = base.shareBaseUrl;
  return merged;
}

/** The home page as it came before the 2D canvas: replaced if the user never changed it. */
function isOldDefaultHome(page: Partial<PageConfig>): boolean {
  return (
    page.preset === 'home' &&
    page.layout === 'grid' &&
    page.source === 'feed' &&
    JSON.stringify(page.fields) === JSON.stringify(['title', 'creator', 'published', 'via']) &&
    !page.filters?.formats?.length &&
    !page.filters?.topics?.length
  );
}

export function normalizePage(page: Partial<PageConfig> & { id: string }): PageConfig {
  if (isOldDefaultHome(page)) return { ...presetPage('home'), title: page.title || 'Home', sidebar: page.sidebar ?? true };
  const template = page.preset ? presetPage(page.preset) : presetPage('home');
  return {
    ...template,
    ...page,
    preset: page.preset,
    filters: { ...NO_FILTERS, ...template.filters, ...page.filters },
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
    pages: patch.pages ?? current.pages,
  });
  if (!['blend', 'primary'].includes(next.feedMode)) throw new Error('feedMode is blend or primary');
  if (!['warn', 'hide', 'allow'].includes(next.unknownContent)) throw new Error('unknownContent is warn, hide or allow');
  next.cacheMiB = Math.max(16, Number(next.cacheMiB) || 1024);
  next.loadPauseMs = Math.min(10_000, Math.max(0, Math.round(Number(next.loadPauseMs) || 0)));
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
