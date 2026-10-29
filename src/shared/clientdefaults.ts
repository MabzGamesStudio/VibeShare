// Default client settings, preset pages and helpers shared by the desktop/CLI client
// and the static web client. Browser-safe: no Node imports.
import type { BloomFilterSettings, PageConfig, PageFilters, PagePreset, Settings } from './clientapi.js';
import { BLOOM_EXPECTED_ITEMS, BLOOM_EXPECTED_MAX } from './bloom.js';
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
export const SETTINGS_REVISION = 3;

export function defaultSettings(): Settings {
  return {
    revision: SETTINGS_REVISION,
    pages: defaultPages(),
    shareBaseUrl: DEFAULT_SHARE_BASE_URL,
    preferences: { maxRating: '16+', formats: [], topics: [], blockedTags: [], blockedCreators: [], creatorKinds: [], languages: ['en'] },
    feedMode: 'blend',
    unknownContent: 'warn',
    blockExternalEmbeds: false,
    showContentPreviews: true,
    defaultAuth: 'pseudonym',
    autoplay: true,
    loadPauseMs: 1500,
    cacheMiB: 1024,
    vvshPrefetchSeconds: 60,
    vvshSkipSeconds: 10,
    vvshDefaultQuality: 'auto',
    vvshScrubWidth: 220,
    historyMode: 'pages',
    debugLogs: false,
    ipfsGateway: 'https://ipfs.io',
    profile: { name: '', kind: 'person' },
    storageService: { enabled: false, quotaGiB: 5, providers: [], perProvider: {} },
    theme: 'system',
    tor: { mode: 'onion', proxy: '' },
    pauseHistory: false,
    searchHistory: true,
    searchSuggestions: true,
    stateRefreshSeconds: 0,
    selectedBloom: { enabled: true, bits: 10_000, expected: BLOOM_EXPECTED_ITEMS },
    previewBloom: { enabled: true, bits: 100_000, expected: BLOOM_EXPECTED_ITEMS },
    searchBloom: { enabled: false, bits: 10_000, expected: BLOOM_EXPECTED_ITEMS },
    accountBloom: { enabled: false, bits: 1_000_000, expected: BLOOM_EXPECTED_ITEMS, resubmitHours: 24 },
    seenContentMode: 'hide',
  };
}

/** The slider stops of one filter: 1, 10, 100, … bits (the exponent of ten). */
export const BLOOM_BIT_STOPS = {
  /** Selected content: up to 100,000,000 bits (12.5 MB of bits). */
  selected: 8,
  /** Previewed content: up to 100,000,000 bits. */
  preview: 8,
  /** The filter carried in search and explore requests: up to 100,000 bits (it travels). */
  search: 5,
  /** The account filter kept on search nodes: up to 1,000,000 bits (what nodes keep). */
  account: 6,
} as const;

/** A filter size on the slider: `10 ** exponent` bits, at most `maxStop` decades. */
export function bloomBitStep(bits: number, maxStop: number): number {
  const value = Number(bits);
  if (!Number.isFinite(value) || value <= 0) throw new Error('A bloom filter size is 1, 10, 100, … bits');
  const exponent = Math.round(Math.log10(value));
  return 10 ** Math.min(maxStop, Math.max(0, exponent));
}

/** The number of items a filter is made for: a whole number, 1 … 10,000,000. */
export function bloomExpected(value: unknown): number {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) throw new Error('The number of items a filter is made for must be a positive number');
  return Math.min(BLOOM_EXPECTED_MAX, Math.max(1, Math.round(count)));
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
    selectedBloom: { ...base.selectedBloom, ...saved?.selectedBloom },
    previewBloom: { ...base.previewBloom, ...saved?.previewBloom },
    searchBloom: { ...base.searchBloom, ...saved?.searchBloom },
    accountBloom: { ...base.accountBloom, ...saved?.accountBloom },
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
  // The preview filter's old hide/demote choice became the seen-content mode.
  const legacyMode = (saved?.previewBloom as { mode?: string } | undefined)?.mode;
  if (saved && saved.seenContentMode === undefined && legacyMode === 'demote') merged.seenContentMode = 'rank';
  delete (merged.previewBloom as { mode?: string }).mode;
  // The old single node filter (carried in requests, optionally stored) is the search
  // filter now; the account's much larger filter starts at its own defaults.
  const legacyNode = (saved as { nodeBloom?: { enabled?: boolean; bits?: number; expected?: number } } | undefined)?.nodeBloom;
  if (saved && !saved.searchBloom && legacyNode) {
    merged.searchBloom = {
      enabled: Boolean(legacyNode.enabled),
      bits: Number(legacyNode.bits ?? merged.searchBloom.bits),
      expected: Number(legacyNode.expected ?? merged.searchBloom.expected),
    };
  }
  // Filter sizes are 1, 10, 100, … bits within each filter's range. Old or hand-edited
  // settings can be out of it (a 1,000,000,000-bit filter made the saved state so large it
  // could not be written out at all), so they snap back into range on load.
  const sizes: [BloomFilterSettings, number][] = [
    [merged.selectedBloom, BLOOM_BIT_STOPS.selected],
    [merged.previewBloom, BLOOM_BIT_STOPS.preview],
    [merged.searchBloom, BLOOM_BIT_STOPS.search],
    [merged.accountBloom, BLOOM_BIT_STOPS.account],
  ];
  for (const [group, stop] of sizes) {
    try {
      group.bits = bloomBitStep(group.bits, stop);
    } catch {
      group.bits = 10_000;
    }
    try {
      group.expected = bloomExpected(group.expected);
    } catch {
      group.expected = BLOOM_EXPECTED_ITEMS;
    }
    group.enabled = Boolean(group.enabled);
  }
  merged.accountBloom.resubmitHours = Math.min(8_760, Math.max(0, Number(merged.accountBloom.resubmitHours) || 0));
  merged.vvshPrefetchSeconds = Math.min(3_600, Math.max(0, Number(merged.vvshPrefetchSeconds) || 0));
  merged.vvshSkipSeconds = Math.min(120, Math.max(1, Number(merged.vvshSkipSeconds) || 10));
  merged.vvshDefaultQuality = ['auto', 'highest', 'lowest'].includes(String(merged.vvshDefaultQuality)) ? String(merged.vvshDefaultQuality) : 'auto';
  // The old preview capture settings are gone (capturing is the publisher's choice and
  // lives in the file now); the width they held carries over as the scrub display size.
  const old = merged as unknown as Record<string, unknown>;
  merged.vvshScrubWidth = Math.min(640, Math.max(80, Number(merged.vvshScrubWidth) || Number(old.vvshPreviewWidth) || 220));
  merged.historyMode = merged.historyMode === 'lazy' ? 'lazy' : 'pages';
  merged.debugLogs = merged.debugLogs === true;
  merged.showContentPreviews = merged.showContentPreviews !== false;
  merged.revision = SETTINGS_REVISION;
  return merged;
}

export function normalizePage(page: Partial<PageConfig> & { id: string }): PageConfig {
  const preset = page.preset as string | undefined;
  const template = preset && preset !== 'home' ? presetPage(preset as PagePreset) : presetPage('videos');
  const normalized = {
    ...template,
    ...page,
    preset: page.preset,
    filters: { ...NO_FILTERS, ...(preset ? template.filters : {}), ...page.filters },
    options: { ...template.options, ...page.options },
    fields: Array.isArray(page.fields) ? page.fields : template.fields,
  } as PageConfig;
  // The 2D canvas layout is gone: pages that used it fall back to the grid.
  if ((normalized.layout as string) === 'canvas') normalized.layout = 'grid';
  return normalized;
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

const LAYOUTS = ['grid', 'list', 'shorts', 'stream', 'masonry'];
const SOURCES = ['feed', 'search', 'subscriptions'];

/**
 * Applies a settings change, checking every value. Throws an Error whose message is
 * meant for the user when something is invalid.
 */
export function applySettingsPatch(current: Settings, patch: Partial<Settings>): Settings {
  // Seen-content filter sizes are checked strictly here: what was typed is refused outright
  // unless it is one of 1, 10, 100, … bits within the filter's range, made for at least one
  // item. Loading saved settings is lenient instead (normalizeSettings snaps anything odd
  // back into range, so a stale giant filter cannot bloat the saved state again).
  const strict: [Partial<BloomFilterSettings> | undefined, number][] = [
    [patch.selectedBloom, BLOOM_BIT_STOPS.selected],
    [patch.previewBloom, BLOOM_BIT_STOPS.preview],
    [patch.searchBloom, BLOOM_BIT_STOPS.search],
    [patch.accountBloom, BLOOM_BIT_STOPS.account],
  ];
  for (const [group, stop] of strict) {
    if (group?.bits !== undefined) bloomBitStep(group.bits, stop);
    if (group?.expected !== undefined) bloomExpected(group.expected);
  }
  const next = normalizeSettings({
    ...current,
    ...patch,
    preferences: { ...current.preferences, ...(patch.preferences ?? {}) },
    profile: { ...current.profile, ...(patch.profile ?? {}) },
    storageService: { ...current.storageService, ...(patch.storageService ?? {}) },
    tor: { ...current.tor, ...(patch.tor ?? {}) },
    selectedBloom: { ...current.selectedBloom, ...(patch.selectedBloom ?? {}) },
    previewBloom: { ...current.previewBloom, ...(patch.previewBloom ?? {}) },
    searchBloom: { ...current.searchBloom, ...(patch.searchBloom ?? {}) },
    accountBloom: { ...current.accountBloom, ...(patch.accountBloom ?? {}) },
    pages: patch.pages ?? current.pages,
  });
  if (!['off', 'onion', 'all'].includes(next.tor.mode)) throw new Error('Tor mode is off, onion or all');
  next.tor.proxy = String(next.tor.proxy ?? '').trim();
  if (next.tor.proxy && !/^(socks5h?:\/\/)?(\[[0-9a-f:.]+\]|[\w.-]+)(:\d{1,5})?\/?$/i.test(next.tor.proxy)) {
    throw new Error('The Tor address is host:port, e.g. 127.0.0.1:9050');
  }
  if (!['blend', 'primary'].includes(next.feedMode)) throw new Error('feedMode is blend or primary');
  if (!['warn', 'hide', 'allow'].includes(next.unknownContent)) throw new Error('unknownContent is warn, hide or allow');
  next.pauseHistory = Boolean(next.pauseHistory);
  next.searchHistory = Boolean(next.searchHistory);
  next.searchSuggestions = Boolean(next.searchSuggestions);
  // Seen-content bloom filters: the size is one of 1, 10, 100, … bits; the preview filter
  // either hides what was previewed or only pushes it down among the other previews.
  try {
    next.selectedBloom.bits = bloomBitStep(next.selectedBloom.bits, BLOOM_BIT_STOPS.selected);
    next.previewBloom.bits = bloomBitStep(next.previewBloom.bits, BLOOM_BIT_STOPS.preview);
    next.searchBloom.bits = bloomBitStep(next.searchBloom.bits, BLOOM_BIT_STOPS.search);
    next.accountBloom.bits = bloomBitStep(next.accountBloom.bits, BLOOM_BIT_STOPS.account);
    next.selectedBloom.expected = bloomExpected(next.selectedBloom.expected);
    next.previewBloom.expected = bloomExpected(next.previewBloom.expected);
    next.searchBloom.expected = bloomExpected(next.searchBloom.expected);
    next.accountBloom.expected = bloomExpected(next.accountBloom.expected);
  } catch (error) {
    throw new Error((error as Error).message);
  }
  if (!['hide', 'rank'].includes(next.seenContentMode)) throw new Error('Seen content is hidden or ranked lower');
  next.selectedBloom.enabled = Boolean(next.selectedBloom.enabled);
  next.previewBloom.enabled = Boolean(next.previewBloom.enabled);
  next.searchBloom.enabled = Boolean(next.searchBloom.enabled);
  next.accountBloom.enabled = Boolean(next.accountBloom.enabled);
  // How often the job resubmits the account filter, in hours: every day unless the user
  // says otherwise. 0 switches the job off — the settings button still submits at any time.
  next.accountBloom.resubmitHours = Math.min(8_760, Math.max(0, Number(next.accountBloom.resubmitHours) || 0));
  next.blockExternalEmbeds = Boolean(next.blockExternalEmbeds);
  next.showContentPreviews = next.showContentPreviews !== false;
  next.cacheMiB = Math.max(16, Number(next.cacheMiB) || 1024);
  next.vvshPrefetchSeconds = Math.min(3_600, Math.max(0, Number(next.vvshPrefetchSeconds) || 0));
  next.vvshSkipSeconds = Math.min(120, Math.max(1, Number(next.vvshSkipSeconds) || 10));
  next.vvshScrubWidth = Math.min(640, Math.max(80, Number(next.vvshScrubWidth) || 220));
  next.historyMode = next.historyMode === 'lazy' ? 'lazy' : 'pages';
  next.loadPauseMs = Math.min(10_000, Math.max(0, Math.round(Number(next.loadPauseMs) || 0)));
  next.stateRefreshSeconds = Math.min(86_400, Math.max(0, Math.round(Number(next.stateRefreshSeconds) || 0)));
  const languages = Array.isArray(next.preferences.languages) ? next.preferences.languages : [];
  next.preferences.languages = [...new Set(languages.map((code) => baseLanguage(String(code))).filter((code) => /^[a-z]{2,3}$/.test(code)))].slice(0, 30);
  next.storageService.quotaGiB = Math.max(0, Number(next.storageService.quotaGiB) || 0);
  // Disk offered per provider node: whole, non-negative numbers of GiB (missing = the default).
  const perProvider: Record<string, number> = {};
  for (const [id, gib] of Object.entries(next.storageService.perProvider ?? {})) {
    const value = Number(gib);
    if (id && Number.isFinite(value)) perProvider[id] = Math.max(0, value);
  }
  next.storageService.perProvider = perProvider;
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
