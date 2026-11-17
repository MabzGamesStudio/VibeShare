// Shared plumbing of the platform API adapters: the small readers for their JSON
// answers, and the factory that turns a platform spec into an Adapter. The platforms
// themselves live one module each in this folder; index.ts lists them all.
//
// Every adapter is off until the operator fills in its credentials (dashboard →
// Crawler → API keys). Its calls follow the API's terms and rate limits and are
// counted against a daily budget the operator sets: crawling uses part of it, the
// rest is kept for searching the platform when clients search this node.
import type { SourceAdapter } from '../../../../shared/sources.js';
import { formatSource, sourceFromUrl } from '../../../../shared/sources.js';
import type { Discovered } from '../../types.js';
import type { Adapter, ApiBudget, ApiInfo, CrawlContext } from '../../types.js';
import { inferTopics, shorten } from '../../types.js';

export type Json = Record<string, unknown>;
export type Keyed<C> = C & ApiBudget & { enabled: boolean };

export const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
export const num = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
};
export const list = <T = Json>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
export const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
export const q = encodeURIComponent;

export function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

/** A page link as a content id: the platform's own id when the link is to one we embed. */
export function linkId(url: string): string {
  const source = sourceFromUrl(url);
  return source ? formatSource(source) : `url:${q(url)}`;
}

export function item(fields: Omit<Discovered, 'topics'> & { topics?: string[] }): Discovered {
  return { ...fields, title: shorten(fields.title, 300), topics: fields.topics ?? inferTopics(`${fields.title} ${fields.description ?? ''}`, fields.tags ?? []) };
}

export interface Spec<C> {
  id: string;
  label: string;
  description: string;
  api: ApiInfo;
  defaults: C;
  /** How this platform's URLs are recognized — the shared SourceAdapter contract. */
  match: SourceAdapter['match'];
  /** The canonical source a recognized URL of this platform points at. */
  parse: SourceAdapter['parse'];
  /** Looks a query up on the platform. */
  find(ctx: CrawlContext, config: Keyed<C>, query: string): Promise<Discovered[]>;
  /** Discovery work other than the node's queries (subreddits, hashtags…). */
  extraTargets?(config: Keyed<C>): string[];
}

export function apiAdapter<C extends Json>(spec: Spec<C>): Adapter<Keyed<C>> {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    api: spec.api,
    defaults: { enabled: true, dailyLimit: spec.api.defaultDailyLimit, searchShare: 0.5, ...spec.defaults } as Keyed<C>,
    match: spec.match,
    parse: spec.parse,
    targets: (config, queries) => [...(spec.extraTargets?.(config) ?? []), ...queries].map((query) => `q:${query}`),
    discover: async (ctx, config, target) => ({ items: await spec.find(ctx, config, target.replace(/^q:/, '')) }),
    search: (ctx, config, query) => spec.find(ctx, config, query),
  };
}
