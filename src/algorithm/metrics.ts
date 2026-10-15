// Popularity metrics clients report about content on other platforms ("claims"), and how
// they turn into credit multipliers. Every content source has its own metrics (YouTube:
// views, likes, comments, subscribers; Reddit: upvotes, comments, members…) and the
// operator sets one multiplier per metric per source, plus a recency factor that decays
// to 1× as the post gets older. Any metric can be switched off; the overall multiplier
// is never less than 1.
import { SOURCE_CATALOG } from './sources.js';

export interface ClaimMetricDef {
  /** The key clients send in `ClaimRequest.metrics`. */
  key: string;
  label: string;
}

const VIEWS_LIKES_COMMENTS: ClaimMetricDef[] = [
  { key: 'views', label: 'Views' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
];

const SOCIAL: ClaimMetricDef[] = [
  ...VIEWS_LIKES_COMMENTS,
  { key: 'shares', label: 'Shares' },
  { key: 'subscribers', label: 'Followers' },
];

/** The metrics of every content source, in display order. Sources not listed use DEFAULT. */
export const SOURCE_METRICS: Record<string, ClaimMetricDef[]> = {
  vibeshare: VIEWS_LIKES_COMMENTS,
  youtube: [
    { key: 'views', label: 'Views' },
    { key: 'likes', label: 'Likes' },
    { key: 'comments', label: 'Comments' },
    { key: 'subscribers', label: 'Channel subscribers' },
  ],
  reddit: [
    { key: 'upvotes', label: 'Upvotes' },
    { key: 'comments', label: 'Comments' },
    { key: 'subscribers', label: 'Members' },
  ],
  twitch: [
    { key: 'views', label: 'Views' },
    { key: 'likes', label: 'Likes' },
    { key: 'comments', label: 'Chat lines' },
    { key: 'followers', label: 'Followers' },
  ],
  x: SOCIAL,
  instagram: SOCIAL,
  tiktok: SOCIAL,
  tumblr: SOCIAL,
  mastodon: SOCIAL,
  bluesky: SOCIAL,
  lemmy: [
    { key: 'upvotes', label: 'Upvotes' },
    { key: 'comments', label: 'Comments' },
    { key: 'subscribers', label: 'Members' },
  ],
  peertube: VIEWS_LIKES_COMMENTS,
  vimeo: VIEWS_LIKES_COMMENTS,
  dailymotion: VIEWS_LIKES_COMMENTS,
  archive: VIEWS_LIKES_COMMENTS,
  wikimedia: VIEWS_LIKES_COMMENTS,
  openverse: VIEWS_LIKES_COMMENTS,
  flickr: VIEWS_LIKES_COMMENTS,
  unsplash: VIEWS_LIKES_COMMENTS,
  pexels: VIEWS_LIKES_COMMENTS,
  giphy: VIEWS_LIKES_COMMENTS,
  tenor: VIEWS_LIKES_COMMENTS,
  imgur: VIEWS_LIKES_COMMENTS,
  deviantart: VIEWS_LIKES_COMMENTS,
  europeana: VIEWS_LIKES_COMMENTS,
  spotify: [
    { key: 'views', label: 'Plays' },
    { key: 'likes', label: 'Likes' },
    { key: 'comments', label: 'Comments' },
    { key: 'followers', label: 'Followers' },
  ],
  soundcloud: [
    { key: 'views', label: 'Plays' },
    { key: 'likes', label: 'Likes' },
    { key: 'comments', label: 'Comments' },
    { key: 'followers', label: 'Followers' },
  ],
  jamendo: VIEWS_LIKES_COMMENTS,
  freesound: VIEWS_LIKES_COMMENTS,
  ipfs: VIEWS_LIKES_COMMENTS,
  web: VIEWS_LIKES_COMMENTS,
};

export const DEFAULT_METRICS: ClaimMetricDef[] = SOCIAL;

export function claimSourceMetrics(source: string): ClaimMetricDef[] {
  return SOURCE_METRICS[source] ?? DEFAULT_METRICS;
}

export interface ClaimMetricRule {
  /** Off: the metric is ignored (it can still be reported, it just pays nothing). */
  enabled: boolean;
  /** Credits multiplier applied to the metric's value, e.g. 0.001 × views. */
  coefficient: number;
}

export interface ClaimRecencyRule {
  enabled: boolean;
  /**
   * Multiplier when the post is brand new, decaying exponentially to 1× with age:
   * `max(1, multiplier × exp(-ageDays / halfLifeDays))`.
   */
  multiplier: number;
  halfLifeDays: number;
}

export interface ClaimSourceRule {
  metrics: Record<string, ClaimMetricRule>;
  recency: ClaimRecencyRule;
}

export interface ClaimConfig {
  /** Credits for a claim of new information, before the multiplier. */
  base: number;
  /** Rewarded claims per account per day. */
  dailyCap: number;
  /**
   * Rules per content source. Sources without rules fall back to `sources.default`
   * (the default rule below is kept there as well).
   */
  sources: Record<string, ClaimSourceRule>;
}

/** The multiplier of one metric's default weight, e.g. YouTube's 0.001 × views. */
function weights(source: string): Record<string, number> {
  switch (source) {
    case 'youtube':
      return { views: 0.001, likes: 0.01, comments: 0.001, subscribers: 0.01 };
    case 'reddit':
    case 'lemmy':
      return { upvotes: 0.01, comments: 0.01, subscribers: 0.01 };
    case 'spotify':
    case 'soundcloud':
      return { views: 0.001, likes: 0.01, comments: 0.001, followers: 0.01 };
    case 'twitch':
      return { views: 0.001, likes: 0.01, comments: 0.001, followers: 0.01 };
    case 'x':
    case 'instagram':
    case 'tiktok':
    case 'tumblr':
    case 'mastodon':
    case 'bluesky':
      return { views: 0.0005, likes: 0.01, comments: 0.005, shares: 0.01, followers: 0.01 };
    default:
      return { views: 0.001, likes: 0.01, comments: 0.005, shares: 0.01, subscribers: 0.01, followers: 0.01, upvotes: 0.01 };
  }
}

function sourceRule(source: string): ClaimSourceRule {
  const metrics: Record<string, ClaimMetricRule> = {};
  for (const metric of claimSourceMetrics(source)) {
    metrics[metric.key] = { enabled: true, coefficient: weights(source)[metric.key] ?? 0.01 };
  }
  return { metrics, recency: { enabled: true, multiplier: 5, halfLifeDays: 30 } };
}

export function claimDefaults(): ClaimConfig {
  const sources: Record<string, ClaimSourceRule> = {};
  for (const source of [...SOURCE_CATALOG.map((s) => s.key), 'default']) sources[source] = sourceRule(source);
  return { base: 2, dailyCap: 100, sources };
}

/** The rule a claim is judged by: the source's own, or the default one. */
export function claimRuleFor(config: ClaimConfig, source: string): ClaimSourceRule {
  return config.sources?.[source] ?? config.sources?.default ?? sourceRule(source);
}

/**
 * The credit multiplier of one claim: the sum of the enabled metrics (coefficient ×
 * value), times the recency factor. Both the recency factor and the multiplier are
 * never less than 1.
 */
export function claimMultiplier(
  rule: ClaimSourceRule,
  metrics: Record<string, number>,
  publishedAt: string | undefined,
  now: number = Date.now()
): { multiplier: number; parts: Record<string, number> } {
  const parts: Record<string, number> = {};
  let sum = 0;
  for (const [key, metricRule] of Object.entries(rule.metrics ?? {})) {
    if (!metricRule?.enabled) continue;
    const value = Number(metrics[key]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const part = Math.max(0, Number(metricRule.coefficient) || 0) * value;
    parts[key] = part;
    sum += part;
  }
  let recency = 1;
  const rec = rule.recency;
  if (rec?.enabled) {
    const ageDays = publishedAt ? Math.max(0, (now - Date.parse(publishedAt)) / 86_400_000) : 0;
    const halfLife = Number(rec.halfLifeDays) > 0 ? Number(rec.halfLifeDays) : 30;
    recency = Math.max(1, (Number(rec.multiplier) || 1) * Math.exp(-ageDays / halfLife));
  }
  parts.recency = recency;
  return { multiplier: Math.max(1, sum * recency), parts };
}