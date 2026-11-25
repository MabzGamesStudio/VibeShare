// Default client settings, preset pages and helpers shared by the desktop/CLI client
// and the static web client. Browser-safe: no Node imports.
import { DEFAULT_SHORT_BUTTONS, SHORT_BUTTONS, type BloomFilterSettings, type PageConfig, type PageFilters, type PagePreset, type Settings } from './clientapi.js';
import { defaultTraceSettings, normalizeTraceSettings } from './tracing.js';
import { BLOOM_EXPECTED_ITEMS, BLOOM_EXPECTED_MAX } from './bloom.js';
import type { Preferences } from './protocol.js';
import { baseLanguage } from './language.js';
import { RATINGS, topicIdOf, type Rating } from './taxonomy.js';

/** Where shared links point unless the user (or the web build) configures another hosted client. */
export const DEFAULT_SHARE_BASE_URL = 'https://mabzgamesstudio.github.io/WebPages/pages/vibeShare/web';
/** Earlier defaults, moved to the current one when settings are loaded. */
const OLD_SHARE_BASE_URLS = ['https://mabzgamesstudio.github.io/webpages/vibeshare'];

/** Topics excluded by default in every customization; the user can take them out. */
export const DEFAULT_BLOCKED_TOPICS = ['ai-slop', 'rage-bait'];

// Every page customization starts with the default exclusions blocked. A page whose own
// block list the user ever changed keeps exactly their list (normalizePage lets a saved
// blockedTopicIds win over this), so a topic unblocked on one page stays unblocked there.
const NO_FILTERS: PageFilters = {
  formats: [],
  topics: [],
  onlyTopics: false,
  creatorKinds: [],
  blockedTopicIds: DEFAULT_BLOCKED_TOPICS.map(topicIdOf),
};

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
        options: { autoplay: true, muted: false, columns: 1, size: 'large', shortsLoop: true, shortsButtonSize: 'medium', shortButtons: [...DEFAULT_SHORT_BUTTONS], shortsComments: 'cover', shortsCommentsSize: 50 },
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
        options: { autoplay: false, muted: true, columns: 1, size: 'large', shortsComments: 'shrink', shortsCommentsSize: 50 },
        sidebar: true,
      };
  }
}

export const PRESETS: PagePreset[] = ['videos', 'shorts', 'images'];

export function defaultPages(): PageConfig[] {
  return PRESETS.map(presetPage);
}

/** Current settings format; older settings get the newer defaults once (normalizeSettings). */
export const SETTINGS_REVISION = 4;

export function defaultSettings(): Settings {
  return {
    revision: SETTINGS_REVISION,
    pages: defaultPages(),
    shareBaseUrl: DEFAULT_SHARE_BASE_URL,
    preferences: {
      maxRating: '16+',
      formats: [],
      topics: [],
      blockedTopics: [...DEFAULT_BLOCKED_TOPICS],
      blockedCreators: [],
      creatorKinds: [],
      languages: ['en'],
      // How the picks weigh in the feed: languages filter hard, topics are favoured and
      // creators are left to the subscriptions and the node's own mix.
      languageLevel: 'only',
      topicLevel: 'strongly',
      creatorLevel: 'ignore',
    },
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
    tracing: defaultTraceSettings(),
    ipfsGateway: 'https://ipfs.io',
    profile: { name: '', kind: 'person' },
    storageService: { enabled: false, quotaGiB: 5, providers: [], perProvider: {} },
    theme: 'system',
    tor: { mode: 'onion', proxy: '' },
    pauseHistory: false,
    searchHistory: false,
    watchHistory: false,
    subscriptionOrder: 'subscribed',
    hostingTabs: ['github', 'gitlab'],
    historyPageSize: 25,
    historyClearDays: 0,
    toastHistory: false,
    logContributions: false,
    toastIcon: true,
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
  // The dual screen is gone too. It was a built-in view, never a page, but an old or
  // hand-edited page list that names it is cleaned out the same way (on every load, so
  // no revision bump is needed — a page the user made themselves keeps its own id).
  const goneDual = (page: { id: string; preset?: string }) => page.id === 'dual' || page.preset === 'dual';
  const pages = (Array.isArray(saved?.pages) && saved.pages.length ? saved.pages : base.pages)
    .filter((page) => !goneHome(page) && !goneDual(page))
    .map((page) => normalizePage(page));
  for (const preset of PRESETS) {
    if (!pages.some((page) => page.id === preset)) pages.push(presetPage(preset));
  }
  merged.pages = pages;
  // The sharing address is kept as it is — including an empty one, which means "share
  // from the page the user is on". Only a value that is missing entirely falls back to
  // the built-in default, and a copy of the old default migrates to the current one.
  const savedShare = (merged as { shareBaseUrl?: unknown }).shareBaseUrl;
  if (savedShare === undefined || savedShare === null || OLD_SHARE_BASE_URLS.includes(String(savedShare).replace(/\/+$/, '').toLowerCase())) {
    merged.shareBaseUrl = base.shareBaseUrl;
  }
  if (saved && (saved.revision ?? 1) < 2) {
    // Revision 2: titles are filtered by language, English only unless the user picked languages.
    if (!saved.preferences?.languages?.length) merged.preferences.languages = [...(base.preferences.languages ?? [])];
    // Tags are gone from the content metadata: whatever was hidden as a tag hides as a topic.
    merged.preferences.blockedTopics = [
      ...new Set([...(merged.preferences.blockedTopics ?? []), ...(((saved.preferences as { blockedTags?: string[] } | undefined)?.blockedTags ?? []))]),
    ];
  }
  if (saved && (saved.revision ?? 1) < 4) {
    // Revision 4: ai-slop and rage-bait are excluded by default. Existing settings gain
    // them once (the same one-time union as the tags above); after this runs the user's
    // list stands on its own, so taking either out afterwards stays out.
    merged.preferences.blockedTopics = [...new Set([...(merged.preferences.blockedTopics ?? []), ...DEFAULT_BLOCKED_TOPICS])];
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
  merged.watchHistory = merged.watchHistory === true;
  merged.logContributions = merged.logContributions === true;
  merged.tracing = normalizeTraceSettings(merged.tracing);
  merged.subscriptionOrder = (['random', 'az', 'za', 'recent'] as const).includes(merged.subscriptionOrder as 'random')
    ? merged.subscriptionOrder
    : 'subscribed';
  // Which hosting platform tabs the provider jobs instructions show (checked = shown).
  merged.hostingTabs = Array.isArray(merged.hostingTabs)
    ? merged.hostingTabs.filter((id): id is string => typeof id === 'string')
    : ['github', 'gitlab'];
  merged.historyPageSize = Math.min(200, Math.max(5, Math.round(merged.historyPageSize || 25)));
  merged.historyClearDays = Math.min(3650, Math.max(0, Math.round(merged.historyClearDays || 0)));
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
  // Formats: "only show" narrows to the picks (the classic filter), "ignore" leaves them out
  // of the request, and the stops in between send them as a recommendation hint.
  const formatLevel = filters.formatLevel ?? (filters.formats?.length ? 'only' : 'ignore');
  if (filters.formats?.length && formatLevel !== 'ignore') {
    out.preferredFormats = filters.formats;
    out.formatLevel = formatLevel;
    if (formatLevel === 'only') out.formats = filters.formats;
  }
  // Formats a page excludes outright (the tri-state red state) never show on that page.
  if (filters.blockedFormats?.length) {
    out.blockedFormats = [...new Set([...(preferences.blockedFormats ?? []), ...filters.blockedFormats])];
  }
  if (filters.creatorKinds?.length) out.creatorKinds = filters.creatorKinds;
  // Topics (by name or id): the level decides whether they are required, favoured to a
  // degree, or left out; a blacklist always wins over the slider.
  const topicPicks = [...(filters.topics ?? []), ...(filters.topicIds ?? [])];
  const topicLevel = filters.topicLevel ?? (filters.onlyTopics ? 'only' : topicPicks.length ? 'strongly' : 'ignore');
  if (topicPicks.length && topicLevel !== 'ignore') {
    out.preferredTopics = [...new Set(topicPicks)];
    out.topicLevel = topicLevel;
    out.topics = [...new Set(topicPicks)];
    if (topicLevel === 'only') out.onlyTopics = true;
  }
  // Creators and groups a page picked: only required or favoured at the slider's level.
  const creatorPicks = filters.creatorIds ?? [];
  const creatorLevel = filters.creatorLevel ?? (filters.onlyCreators ? 'only' : 'ignore');
  if (creatorPicks.length && creatorLevel !== 'ignore') {
    out.preferredCreators = [...new Set(creatorPicks)];
    out.creatorLevel = creatorLevel;
    if (creatorLevel === 'only') {
      out.creatorIds = [...new Set([...(preferences.creatorIds ?? []), ...creatorPicks])];
      out.onlyCreators = true;
    }
  }
  // Creators, groups and topics a page picked with its + buttons: a blacklist keeps them out.
  const blocked = [...(filters.blockedCreatorIds ?? []), ...(filters.blockedTopicIds ?? [])];
  if (blocked.length) {
    out.blockedCreators = [...new Set([...(preferences.blockedCreators ?? []), ...blocked])];
    out.blockedTopics = [...new Set([...(preferences.blockedTopics ?? []), ...blocked])];
  }
  // Platforms (content sources like youtube): the level decides whether the picks are the
  // only ones shown or favoured to a degree; a blacklist always excludes.
  const platformPicks = filters.platforms ?? [];
  const platformLevel = filters.platformLevel ?? 'ignore';
  if (platformPicks.length && platformLevel !== 'ignore') {
    out.preferredPlatforms = [...new Set(platformPicks)];
    out.platformLevel = platformLevel;
  }
  if (filters.blockedPlatforms?.length) {
    out.blockedPlatforms = [...new Set([...(preferences.blockedPlatforms ?? []), ...filters.blockedPlatforms])];
  }
  // Content types to leave out entirely (age-rating reasons like "violence").
  if (filters.disregard?.length) out.disregard = [...new Set([...(preferences.disregard ?? []), ...filters.disregard])];
  out.maxRating = lowerRating(preferences.maxRating, filters.maxRating);
  return out;
}

/**
 * Where shared links point: the sharing address set in Settings (a hosted copy of the
 * web client) overrides the address this page is served from whenever it is set to one.
 * An empty or unusable value means "share from where I am now": the domain and path the
 * page is served from — the caller passes it (only the page knows the path the app is
 * mounted under), or the browser's own origin stands in when no caller can say.
 */
export function shareBase(configured: string, clientBase?: string): string {
  const wanted = configured.trim();
  if (/^https?:\/\/\S+$/i.test(wanted)) return wanted;
  const here = (clientBase ?? '').trim();
  if (here) return here;
  return (globalThis as { window?: { location?: { origin?: string } } }).window?.location?.origin ?? '';
}

/** The link that opens a content id in a hosted web client (normal routes). */
export function shareLink(baseUrl: string, contentId: string, providerHint?: string): string {
  // Only a completely empty base (nothing to build on) falls back to the default host.
  const base = (baseUrl || DEFAULT_SHARE_BASE_URL).replace(/#.*$/, '').replace(/\/index\.html$/, '').replace(/\/+$/, '');
  const hint = providerHint ? `?p=${encodeURIComponent(providerHint)}` : '';
  return `${base}/watch/${encodeURIComponent(contentId)}${hint}`;
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
    tracing: {
      ...current.tracing,
      ...(patch.tracing ?? {}),
      levels: { ...current.tracing.levels, ...(patch.tracing?.levels ?? {}) },
    },
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
  // Toast messages: saved copies are off by default; the bell icon is on unless removed.
  next.toastHistory = Boolean(next.toastHistory);
  next.logContributions = Boolean(next.logContributions);
  next.tracing = normalizeTraceSettings(next.tracing);
  next.toastIcon = next.toastIcon !== false;
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
  // An empty sharing address is valid and kept: it means "share from the page the user
  // is on now". Anything else must be an http(s) URL.
  next.shareBaseUrl = String(next.shareBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (next.shareBaseUrl) {
    try {
      const url = new URL(next.shareBaseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    } catch {
      throw new Error('The share link address must be an http(s) URL');
    }
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
    if (page.options.imageHeight !== undefined) page.options.imageHeight = Math.min(100, Math.max(10, Math.round(Number(page.options.imageHeight) || 72)));
    if (page.filters.maxRating && !RATINGS.includes(page.filters.maxRating)) delete page.filters.maxRating;
  }
  return next;
}
