import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { log } from '../shared/log.js';
import type { Preferences } from '../shared/protocol.js';
import type { TraceStore } from '../shared/tracing-node.js';
import type { Entry } from './registry.js';

export const STRATEGIES = ['balanced', 'hot', 'new', 'top', 'random', 'custom'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export interface RankingConfig {
  strategy: Strategy;
  /** Weights of the balanced strategy. */
  weights: { quality: number; recency: number; preference: number; discovery: number };
  /** Hours for recency to halve. */
  halfLifeHours: number;
  /** Gravity of the hot strategy (higher = old items sink faster). */
  gravity: number;
  /** For the custom strategy: path to an ES module whose default export ranks items. */
  module?: string;
  /** Shown to clients, so users know what they are getting. */
  description?: string;
}

export interface RankContext {
  preferences: Preferences;
  /** Same seed → same random order (stable pages). */
  seed: string;
  now: number;
  config: RankingConfig;
  /** Helpers custom rankers can reuse. */
  helpers: typeof helpers;
  /** The node's trace log, when it keeps one: one summary event per ranking. */
  trace?: TraceStore;
  /** Internal: built-in rankers report their winning score here, for that summary. */
  reportTop?: (topScore: number) => void;
}

/** A custom ranker returns the items in order, or a score per item id (higher first). */
export type Ranker = (items: Entry[], context: RankContext) => Entry[] | Record<string, number> | Promise<Entry[] | Record<string, number>>;

/** Lower bound of the Wilson score interval: "how good is it, at least, given the votes". */
export function wilson(likes: number, dislikes: number, z = 1.96): number {
  const n = likes + dislikes;
  if (n === 0) return 0;
  const p = likes / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

/** Smoothed approval, starting new content at 0.5 instead of 0. */
export function quality(entry: Entry): number {
  return (entry.likes + 2) / (entry.likes + entry.dislikes + 4);
}

export function recency(entry: Entry, now: number, halfLifeHours: number): number {
  const hours = Math.max(0, (now - Date.parse(entry.publishedAt)) / 3600_000);
  return Math.pow(0.5, hours / Math.max(1, halfLifeHours));
}

/** How well an entry matches the topics the user favours (0–1). */
export function preferenceMatch(entry: Entry, preferences: Preferences): number {
  const topics = preferences.topics ?? [];
  if (!topics.length) return 0;
  const hits = entry.topics.filter((topic) => topics.includes(topic)).length;
  return Math.min(1, hits / Math.min(topics.length, 2));
}

export function seededRandom(seed: string, id: string): number {
  return createHash('sha256').update(`${seed}:${id}`).digest().readUInt32BE(0) / 0x1_0000_0000;
}

export const helpers = { wilson, quality, recency, preferenceMatch, seededRandom };

function byScore(items: Entry[], score: (entry: Entry) => number, reportTop?: (topScore: number) => void): Entry[] {
  const scores = new Map(items.map((entry) => [entry.id, score(entry)]));
  if (reportTop && scores.size) reportTop(Math.max(...scores.values()));
  return [...items].sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || b.publishedAt.localeCompare(a.publishedAt));
}

const BUILT_IN: Record<Exclude<Strategy, 'custom'>, Ranker> = {
  balanced(items, { config, now, preferences, seed, reportTop }) {
    const w = config.weights;
    return byScore(
      items,
      (entry) =>
        w.quality * quality(entry) +
        w.recency * recency(entry, now, config.halfLifeHours) +
        w.preference * preferenceMatch(entry, preferences) +
        w.discovery * seededRandom(seed, entry.id),
      reportTop
    );
  },
  hot(items, { config, now, preferences, reportTop }) {
    return byScore(
      items,
      (entry) => {
        const hours = Math.max(0, (now - Date.parse(entry.publishedAt)) / 3600_000);
        const votes = entry.likes - entry.dislikes + 1;
        return (votes * (1 + preferenceMatch(entry, preferences))) / Math.pow(hours + 2, config.gravity);
      },
      reportTop
    );
  },
  new(items) {
    return [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  },
  top(items, { reportTop }) {
    return byScore(items, (entry) => wilson(entry.likes, entry.dislikes), reportTop);
  },
  random(items, { seed, reportTop }) {
    return byScore(items, (entry) => seededRandom(seed, entry.id), reportTop);
  },
};

export const STRATEGY_DESCRIPTIONS: Record<Strategy, string> = {
  balanced: 'A mix of approval, freshness, your favourite topics and a little discovery.',
  hot: 'What is getting votes right now.',
  new: 'Newest first.',
  top: 'Best approved of all time.',
  random: 'A random shuffle of everything that fits your filters.',
  custom: 'A ranking written by the operator of this node.',
};

const customCache = new Map<string, Ranker>();

async function loadCustom(path: string, traces?: TraceStore): Promise<Ranker | null> {
  if (customCache.has(path)) return customCache.get(path)!;
  try {
    const module = (await import(pathToFileURL(path).href)) as { default?: Ranker; rank?: Ranker };
    const ranker = module.default ?? module.rank;
    if (typeof ranker !== 'function') throw new Error('the module exports no ranking function');
    customCache.set(path, ranker);
    return ranker;
  } catch (error) {
    log.error(`Custom ranking module ${path}: ${(error as Error).message}; falling back to balanced`);
    traces?.trace('error', 'algorithm.ranking', 'function:loadCustom', {
      message: `${path.slice(-60)} did not load; falling back to balanced`,
      error: (error as Error).message,
    });
    return null;
  }
}

export async function rank(items: Entry[], context: Omit<RankContext, 'helpers'>): Promise<Entry[]> {
  let topScore: number | undefined;
  const full: RankContext = {
    ...context,
    helpers,
    // The winning score is only asked of the strategies, so the summary can carry it.
    reportTop: (score) => {
      topScore = score;
    },
  };
  const { strategy, module } = context.config;
  const started = Date.now();
  let ranked: Entry[] | null = null;
  if (strategy === 'custom' && module) {
    const ranker = await loadCustom(module, context.trace);
    if (ranker) {
      try {
        const result = await ranker(items, full);
        if (Array.isArray(result)) {
          ranked = result;
        } else {
          const scores = Object.values(result);
          if (scores.length) topScore = Math.max(...scores);
          ranked = byScore(items, (entry) => result[entry.id] ?? 0);
        }
      } catch (error) {
        log.error(`Custom ranking failed: ${(error as Error).message}`);
        context.trace?.trace('error', 'algorithm.ranking', 'function:rank', {
          message: 'the custom ranking failed; falling back to the built-in strategy',
          error: (error as Error).message,
        });
      }
    }
  }
  if (!ranked) ranked = (BUILT_IN[strategy as Exclude<Strategy, 'custom'>] ?? BUILT_IN.balanced)(items, full) as Entry[];
  // One summary per ranking: what strategy decided, over how many candidates, and how it scored.
  const ms = Date.now() - started;
  context.trace?.trace('basic', 'algorithm.ranking', 'function:rank', {
    message: `${strategy} ranked ${items.length} candidates in ${ms} ms`,
    data: {
      strategy,
      candidates: items.length,
      returned: ranked.length,
      ...(topScore !== undefined ? { topScore: Math.round(topScore * 1000) / 1000 } : {}),
      ms,
    },
  });
  return ranked;
}
