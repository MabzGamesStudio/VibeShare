// Feed and search pages: which algorithm nodes to ask (and on what terms), blending
// their answers into one page, and the seen-content filters applied on top of what comes
// back — plus the filter bookkeeping the Settings screen drives (the small copy that
// travels with requests, the copies sent to search nodes, and the resubmission job of
// the account filter). One collaborator of ClientCore; browser-safe.
import type {
  BloomStatus,
  FeedItem,
  FeedResponse,
  NodeEntry,
  PageFilters,
  PageSource,
} from '../shared/clientapi.js';
import { pagePreferences } from '../shared/clientdefaults.js';
import { base64url, fromBase64url } from '../shared/encoding.js';
import { badRequest } from '../shared/errors.js';
import { matchesLanguages } from '../shared/language.js';
import { BLOOM_INLINE_MAX_BYTES, type BloomFilterData } from '../shared/bloom.js';
import { conflictsWithDisregard } from '../shared/taxonomy.js';
import { sourceKeyOf } from '../algorithm/sources.js';
import { parseContentId } from '../shared/sources.js';
import type { AccountFilterState, AlgorithmInfo, BloomStorageState, ContentItem, Page, Preferences } from '../shared/protocol.js';
import { errorText } from './nodes.js';
import { askJson } from './nodes.js';
import { SCOPES_OF_EVENT } from './bloom.js';
import { rememberSearch } from './content.js';
import type { ClientCore } from './core.js';

export type FeedKind = 'feed' | 'search' | 'latest';

export function encodeCursor(value: Record<string, string | null>): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeCursor(text: string | undefined): Record<string, string | null> | null {
  if (!text) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(text))) as Record<string, string | null>;
  } catch {
    return null;
  }
}

/** A timer that never holds a process open (unref'd where the runtime knows the trick). */
function later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** Feed and search pages, and the seen-content filters, for one client. */
export class Feeds {
  constructor(private readonly core: ClientCore) {}

  feedItem(node: NodeEntry, item: ContentItem): FeedItem {
    // Thumbnails the algorithm node stores come through the client; those of discovered content are on the platform.
    const remote = item.thumbnail && /^https?:\/\//.test(item.thumbnail) ? item.thumbnail : undefined;
    const key = !remote ? item.thumbnail?.split('/').pop() : undefined;
    // The images of a list-of-images content: an image published on VibeShare is named by
    // its content id and plays through this client like any other native content.
    const gallery = item.gallery?.map((media) => {
      const parsed = parseContentId(media.url);
      return parsed?.native ? { ...media, url: this.core.options.streamUrl(parsed.base, false) } : media;
    });
    return {
      ...item,
      gallery,
      via: node.id,
      viaName: node.name,
      thumbnailUrl: remote ?? (key ? this.core.options.thumbnailUrl(node, key) : undefined),
    };
  }

  private algorithmsFor(kind: FeedKind): NodeEntry[] {
    const priceKind = kind === 'search' ? 'search' : 'feed';
    return this.core.nodes.active('algorithm').filter((node) => this.core.nodes.affordable(node, this.core.nodes.algorithmPrice(node, priceKind)));
  }

  /**
   * The seen-content filter carried inside a request to an algorithm node — the search
   * filter: only when the user sends one at all, and only while it is small enough for
   * that node to accept. The account's much larger filter never travels this way: the node
   * keeps it and applies it while searching.
   */
  private bloomPayload(node: NodeEntry): { bloom?: BloomFilterData } {
    const settings = this.core.settings.searchBloom;
    if (!settings.enabled) return {};
    const limit = (node.info as AlgorithmInfo | undefined)?.bloom?.inlineMaxBits ?? BLOOM_INLINE_MAX_BYTES * 8;
    const payload = this.core.blooms.payload('search', limit);
    return payload ? { bloom: payload } : {};
  }

  /**
   * The local seen-content filters applied to a page: what the user has opened and the
   * previews they have seen both count as seen. Depending on the seen-content mode, seen
   * content is either eliminated from the results completely, or kept with an altered
   * ranking — pushed down below everything the user has not seen. The "*watched" mark
   * only goes to content actually opened before (the selected filter): a preview is not
   * a watch, so the first open of previewed content is never marked watched.
   */
  private applySeenFilters(items: FeedItem[], imageMedium = false): FeedItem[] {
    const rank = this.core.settings.seenContentMode === 'rank';
    const shown: FeedItem[] = [];
    const demoted: FeedItem[] = [];
    for (const item of items) {
      // Only the algorithm node's small leading native group is seen-exempt. Other
      // native items still follow the user's ordinary seen-content preference — except
      // in the images medium, where a VibeShare-native picture leads the page, seen or
      // not (nativeFirst keeps the native ones at the front below).
      const nativeImage = imageMedium && item.id.startsWith('vs1') && (item.format === 'image' || item.format === 'image-list');
      if (item.nativeSuggestion || nativeImage) {
        const identity = { id: item.id, contentId: item.contentId, link: item.link };
        shown.push(this.core.blooms.sees('selected', identity) ? { ...item, seen: true } : item);
        continue;
      }
      const identity = { id: item.id, contentId: item.contentId, link: item.link };
      const seen = this.core.blooms.sees('selected', identity) || this.core.blooms.sees('preview', identity);
      if (!seen) {
        shown.push(item);
        continue;
      }
      const marked = this.core.blooms.sees('selected', identity) ? { ...item, seen: true } : item;
      if (rank) demoted.push(marked);
    }
    return [...shown, ...demoted];
  }

  /** Native content stays ahead of external results after blending or local ranking. */
  private nativeFirst(items: FeedItem[]): FeedItem[] {
    return [...items.filter((item) => item.id.startsWith('vs1')), ...items.filter((item) => !item.id.startsWith('vs1'))];
  }
  /**
   * Asks the algorithm nodes for a page. "blend" mixes every enabled node by priority
   * (round robin, without duplicates); "primary" uses the first node that answers.
   */
  async collect(kind: FeedKind, body: Record<string, unknown>, cursor?: string): Promise<FeedResponse> {
    if (kind === 'search') rememberSearch(this.core, String(body.query ?? ''));
    const nodes = this.algorithmsFor(kind);
    // Entry and result of the feed/search flow: which page was asked of how many nodes,
    // and what came back (counts and statuses only — never the items themselves).
    const component = kind === 'latest' ? 'core.subscriptions' : `core.${kind}`;
    this.core.traces.trace('basic', component, `${kind} page`, {
      message: kind === 'search' ? String(body.query ?? '').slice(0, 120) : undefined,
      data: { nodes: nodes.length, cursor: Boolean(cursor) },
    });
    const errors: FeedResponse['errors'] = [];
    if (!nodes.length) return { items: [], errors: [{ node: '', name: 'Client', error: 'No algorithm node is enabled' }] };
    const cursors = decodeCursor(cursor) ?? {};
    const path = kind === 'feed' ? '/v1/feed' : kind === 'search' ? '/v1/search' : '/v1/creators/latest';
    const priceKind = kind === 'search' ? 'search' : 'feed';
    // The subscriptions feed ("latest") leads with native suggestions and otherwise lists
    // the newest followed content: seen-content filters do not touch it. No filter travels along,
    // and nothing is hidden, demoted or marked locally — it lists what is recent, seen
    // or not. Every other feed and search results are filtered as the user chose.
    const seenContent = kind !== 'latest';
    // Nodes filter by language too; this covers nodes that do not, and content they pass on.
    const languages = ((body.preferences ?? body.filters) as Preferences | undefined)?.languages ?? this.core.settings.preferences.languages;
    const wanted = (item: ContentItem) => matchesLanguages(item, languages);
    // The images medium: native pictures lead it and are never hidden by seen-filters.
    const imageMedium = (((body.preferences ?? body.filters) as Preferences | undefined)?.formats ?? []).includes('image');
    const ask = async (node: NodeEntry, limit: number): Promise<Page<ContentItem>> => {
      const price = this.core.nodes.algorithmPrice(node, priceKind);
      // (Paid answers carry the new balance; nothing else is asked — except when the node
      // keeps the user's seen-content filter, which it only applies to the account.)
      const identify = price > 0 || (seenContent && (this.core.settings.searchBloom.enabled || this.core.settings.accountBloom.enabled));
      return askJson<Page<ContentItem>>(this.core, 
        node,
        path,
        {
          ...body,
          previews: this.core.settings.showContentPreviews,
          ...(seenContent ? this.bloomPayload(node) : {}),
          limit,
          cursor: cursors[node.id] ?? undefined,
        },
        identify
      );
    };

    if (this.core.settings.feedMode === 'primary') {
      const started = Object.keys(cursors);
      const candidates = started.length ? nodes.filter((node) => started.includes(node.id)) : nodes;
      for (const node of candidates) {
        try {
          const page = await ask(node, 24);
          const shown = this.nativeFirst(
            seenContent
              ? this.applySeenFilters(page.items.filter(wanted).map((item) => this.feedItem(node, item)), imageMedium)
              : page.items.filter(wanted).map((item) => this.feedItem(node, item))
          );
          this.core.traces.trace('basic', component, `${kind} page → done`, { data: { items: shown.length, errors: errors.length } });
          return {
            items: shown,
            cursor: page.cursor ? encodeCursor({ [node.id]: page.cursor }) : undefined,
            errors,
          };
        } catch (error) {
          errors.push({ node: node.id, name: node.name, error: errorText(error) });
        }
      }
      this.core.traces.trace('basic', component, `${kind} page → failed`, { data: { errors: errors.length }, error: errors[0]?.error });
      return { items: [], errors };
    }

    const live = nodes.filter((node) => !(node.id in cursors) || cursors[node.id] !== null);
    const per = Math.max(8, Math.ceil(24 / Math.max(1, live.length)));
    const pages = await Promise.all(
      live.map(async (node) => {
        try {
          return { node, page: await ask(node, per) };
        } catch (error) {
          errors.push({ node: node.id, name: node.name, error: errorText(error) });
          return { node, page: null };
        }
      })
    );
    const seen = new Set<string>();
    const items: FeedItem[] = [];
    const longest = Math.max(0, ...pages.map(({ page }) => page?.items.length ?? 0));
    for (let i = 0; i < longest; i++) {
      for (const { node, page } of pages) {
        const item = page?.items[i];
        if (!item || !wanted(item)) continue;
        const base = item.id.split('~')[0];
        if (seen.has(base)) continue;
        seen.add(base);
        items.push(this.feedItem(node, item));
      }
    }
    const next: Record<string, string | null> = { ...cursors };
    for (const { node, page } of pages) next[node.id] = page ? (page.cursor ?? null) : (cursors[node.id] ?? null);
    const more = Object.values(next).some((value) => value !== null);
    const shown = this.nativeFirst(seenContent ? this.applySeenFilters(items, imageMedium) : items);
    this.core.traces.trace('basic', component, `${kind} page → done`, { data: { items: shown.length, errors: errors.length } });
    return {
      items: shown,
      cursor: more ? encodeCursor(next) : undefined,
      errors,
    };
  }

  /** One endpoint for every page: its source, query and filters, within the user's preferences. */
  async browse(body: { source?: PageSource; query?: string; filters?: Partial<PageFilters>; sort?: string; cursor?: string; seed?: string }): Promise<FeedResponse> {
    this.core.traces.trace('basic', 'core.browse', `browse ${body.source ?? 'feed'}`, {
      message: body.query ? String(body.query).slice(0, 120) : undefined,
      data: { sort: body.sort, cursor: Boolean(body.cursor) },
    });
    const preferences = pagePreferences(this.core.settings.preferences, body.filters);
    // The creators the user subscribes to join the page's creator picks (on unless the page
    // turned its "Subscribed creators" button off) — sent at the creators slider's level.
    if (body.filters?.subscribedCreators !== false && preferences.creatorLevel && preferences.creatorLevel !== 'ignore') {
      const subscribed = this.core.store.data.data.subscriptions.filter((entry) => entry.kind !== 'topic').map((entry) => entry.id);
      if (subscribed.length) {
        preferences.preferredCreators = [...new Set([...(preferences.preferredCreators ?? []), ...subscribed])];
        if (preferences.onlyCreators) preferences.creatorIds = [...new Set([...(preferences.creatorIds ?? []), ...subscribed])];
      }
    }
    // On top of whatever the nodes filtered, the client itself drops any item whose
    // metadata conflicts with the content types this page disregards.
    const platformPicks = new Set(preferences.preferredPlatforms ?? []);
    const platformBlocked = new Set(preferences.blockedPlatforms ?? []);
    const keep = (response: FeedResponse): FeedResponse => ({
      ...response,
      items: response.items.filter((item) => {
        if (conflictsWithDisregard(item, preferences.disregard ?? [])) return false;
        // The platforms a page whitelists and blacklists are enforced here as well, so the
        // choice works even before every algorithm node weighs them.
        const source = sourceKeyOf({ id: item.id });
        if (platformBlocked.has(source)) return false;
        if (preferences.platformLevel === 'only' && platformPicks.size && !platformPicks.has(source)) return false;
        return true;
      }),
    });
    if (body.source === 'search') {
      const sort = body.sort ?? body.filters?.sort;
      return this.collect('search', { query: String(body.query ?? ''), filters: preferences, sort }, body.cursor).then(keep);
    }
    if (body.source === 'subscriptions') {
      const creators = this.core.store.data.data.subscriptions.map((s) => s.id);
      if (!creators.length) return Promise.resolve({ items: [], errors: [] });
      return this.collect('latest', { creators, preferences }, body.cursor).then((response) => {
        // The carousel can order by the newest posting: remember when each creator last posted.
        for (const item of response.items) {
          const entry = this.core.store.data.data.subscriptions.find((s) => s.id === item.creator?.id);
          if (entry && item.publishedAt && (!entry.lastPostAt || Date.parse(item.publishedAt) > Date.parse(entry.lastPostAt))) {
            entry.lastPostAt = item.publishedAt;
            this.core.store.changed();
          }
        }
        return keep(response);
      });
    }
    return this.collect('feed', { preferences, seed: body.seed }, body.cursor).then(keep);
  }
  /**
   * A preview that came on screen: recorded by the preview filter (and the copy sent to
   * search nodes) as content the user has seen without selecting it.
   */
  markPreviewed(body: { id?: string; contentId?: string; link?: string }): { added: number } {
    if (!body.id) throw badRequest('id is required');
    return { added: this.core.blooms.mark({ id: body.id, contentId: body.contentId, link: body.link }, SCOPES_OF_EVENT.preview) };
  }

  /** The state of the four seen-content filters (what the settings screen shows). */
  bloomStatus(): BloomStatus {
    return this.core.blooms.status();
  }

  /** Forgets one filter; the user is warned about this before it is called. */
  resetBloom(scope: string): BloomStatus {
    if (scope !== 'selected' && scope !== 'preview' && scope !== 'search' && scope !== 'account') {
      throw badRequest('scope is selected, preview, search or account');
    }
    this.core.blooms.reset(scope);
    return this.core.blooms.status();
  }

  /** The storage a search node offers for seen-content filters, and the user's own there. */
  bloomOffers(node: NodeEntry): Promise<BloomStorageState> {
    return this.core.nodes.client(node).json<BloomStorageState>('/v1/bloom');
  }

  /** Pays a search node (its own price and duration) to keep a copy of the search filter a while. */
  async buyBloomStorage(node: NodeEntry, tier: string): Promise<BloomStorageState> {
    if (!tier) throw badRequest('tier is required');
    const filter = this.core.blooms.filter('search').toJSON();
    const state = await this.core.nodes.client(node).json<BloomStorageState>('/v1/bloom', { method: 'PUT', body: { tier, filter } });
    void this.core.nodes.refreshBalance(node);
    return state;
  }

  /** Stops the search node from keeping the user's filter (it is deleted there). */
  async dropBloomStorage(node: NodeEntry): Promise<BloomStorageState> {
    const state = await this.core.nodes.client(node).json<BloomStorageState>('/v1/bloom', { method: 'DELETE' });
    void this.core.nodes.refreshBalance(node);
    return state;
  }

  // -------------------------------------------------------------------------
  // The account filter: the much larger copy of what the user has seen, kept long term
  // on search nodes (never sent along with requests). The settings button submits it at
  // any time; the resubmission job redoes that every `resubmitHours` hours (0 = by hand).

  /** The account filter one search node keeps for the user, and how big it may be. */
  accountFilterState(node: NodeEntry): Promise<AccountFilterState> {
    return this.core.nodes.client(node).json<AccountFilterState>('/v1/account-filter');
  }

  /** Sends this user's account filter to one search node (it replaces what is kept there). */
  submitAccountFilter(node: NodeEntry): Promise<AccountFilterState> {
    const filter = this.core.blooms.filter('account').toJSON();
    return this.core.nodes.client(node).json<AccountFilterState>('/v1/account-filter', { method: 'PUT', body: { filter } });
  }

  /** Stops one search node from keeping the account filter. */
  dropAccountFilter(node: NodeEntry): Promise<AccountFilterState> {
    return this.core.nodes.client(node).json<AccountFilterState>('/v1/account-filter', { method: 'DELETE' });
  }

  /**
   * The button: submits the account filter to every enabled search node at once. Each
   * node answers (or fails) on its own; the summary says which is which.
   */
  async submitAccountFilters(): Promise<{ node: string; name: string; ok: boolean; error?: string; updatedAt?: string }[]> {
    const nodes = this.core.nodes.active('algorithm');
    return Promise.all(
      nodes.map(async (node) => {
        try {
          const state = await this.submitAccountFilter(node);
          return { node: node.id, name: node.name, ok: true, updatedAt: state.updatedAt };
        } catch (error) {
          return { node: node.id, name: node.name, ok: false, error: errorText(error) };
        }
      })
    );
  }

  /** The resubmission job's timer (null while the job is switched off). */
  private bloomJob: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever the job is (re)scheduled, so an old run never schedules again. */
  private bloomJobRun = 0;

  /**
   * Runs the resubmission job on its schedule: right away whenever it is switched on or
   * its interval changes, then every `resubmitHours` hours. `resubmitHours: 0` switches
   * the job off — the settings button still submits at any time.
   */
  scheduleBloomJob(): void {
    this.stopBloomJob();
    const { enabled, resubmitHours } = this.core.settings.accountBloom;
    if (!enabled || !(resubmitHours > 0)) return;
    const intervalMs = Math.max(1_000, resubmitHours * 3_600_000);
    const generation = ++this.bloomJobRun;
    const run = async () => {
      try {
        await this.submitAccountFilters();
      } catch {
        // one quiet round: the next run (or the button) tries again
      }
      // Switched off or rescheduled while it was submitting: nothing more from this run.
      if (generation !== this.bloomJobRun) return;
      this.bloomJob = later(intervalMs, run);
    };
    // Right away, so a fresh client (or a setting just switched on) does not wait a day.
    this.bloomJob = later(250, run);
  }

  /** Stops the resubmission job (its filter stays on the nodes until it is dropped there). */
  stopBloomJob(): void {
    this.bloomJobRun++;
    if (this.bloomJob) clearTimeout(this.bloomJob);
    this.bloomJob = null;
  }
}
