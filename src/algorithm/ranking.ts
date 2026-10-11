import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { log } from '../shared/log.js';
import type { Preferences } from '../shared/protocol.js';
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

function byScore(items: Entry[], score: (entry: Entry) => number): Entry[] {
  const scores = new Map(items.map((entry) => [entry.id, score(entry)]));
  return [...items].sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || b.publishedAt.localeCompare(a.publishedAt));
}

const BUILT_IN: Record<Exclude<Strategy, 'custom'>, Ranker> = {
  balanced(items, { config, now, preferences, seed }) {
    const w = config.weights;
    return byScore(
      items,
      (entry) =>
        w.quality * quality(entry) +
        w.recency * recency(entry, now, config.halfLifeHours) +
        w.preference * preferenceMatch(entry, preferences) +
        w.discovery * seededRandom(seed, entry.id)
    );
  },
  hot(items, { config, now, preferences }) {
    return byScore(items, (entry) => {
      const hours = Math.max(0, (now - Date.parse(entry.publishedAt)) / 3600_000);
      const votes = entry.likes - entry.dislikes + 1;
      return (votes * (1 + preferenceMatch(entry, preferences))) / Math.pow(hours + 2, config.gravity);
    });
  },
  new(items) {
    return [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  },
  top(items) {
    return byScore(items, (entry) => wilson(entry.likes, entry.dislikes));
  },
  random(items, { seed }) {
    return byScore(items, (entry) => seededRandom(seed, entry.id));
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

async function loadCustom(path: string): Promise<Ranker | null> {
  if (customCache.has(path)) return customCache.get(path)!;
  try {
    const module = (await import(pathToFileURL(path).href)) as { default?: Ranker; rank?: Ranker };
    const ranker = module.default ?? module.rank;
    if (typeof ranker !== 'function') throw new Error('the module exports no ranking function');
    customCache.set(path, ranker);
    return ranker;
  } catch (error) {
    log.error(`Custom ranking module ${path}: ${(error as Error).message}; falling back to balanced`);
    return null;
  }
}

export async function rank(items: Entry[], context: Omit<RankContext, 'helpers'>): Promise<Entry[]> {
  const full: RankContext = { ...context, helpers };
  const { strategy, module } = context.config;
  if (strategy === 'custom' && module) {
    const ranker = await loadCustom(module);
    if (ranker) {
      try {
        const result = await ranker(items, full);
        if (Array.isArray(result)) return result;
        return byScore(items, (entry) => result[entry.id] ?? 0);
      } catch (error) {
        log.error(`Custom ranking failed: ${(error as Error).message}`);
      }
    }
  }
  const ranker = BUILT_IN[strategy as Exclude<Strategy, 'custom'>] ?? BUILT_IN.balanced;
  return ranker(items, full) as Entry[];
}
