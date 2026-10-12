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
        layout: 'grid',
        source: 'feed',
        filters: { ...NO_FILTERS },
        thumbnail: true,
        fields: ['title', 'creator', 'published', 'via'],
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
        options: { autoplay: false, muted: true, columns: 0, size: 'medium' },
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

export function normalizePage(page: Partial<PageConfig> & { id: string }): PageConfig {
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
