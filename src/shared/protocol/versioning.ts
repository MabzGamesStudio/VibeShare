// Protocol versions, the compatibility matrix and the capability map. The wire
// carries one machine-readable version range (`NodeInfoBase.protocol`) beside the
// classic `v`, and one flat `features` map of what a node supports — both derived
// here from constants, so every node and client agrees without duplicating logic.
import { VERSION } from '../version.js';
import { PAGE_LIMITS, SUGGESTION_KINDS } from './content.js';
import type { AlgorithmInfo, NodeInfo, ProviderInfo } from './info.js';

/** The oldest protocol version this build still speaks. v1 stays frozen forever. */
export const PROTOCOL_MIN = 1;

/**
 * The current protocol version, in `NodeInfoBase.v` for old readers. Bumped to 2 for
 * the additive v2 surfaces: version ranges, extension bags (`x`) and capability maps.
 */
export const PROTOCOL_VERSION = 2;

export const SOFTWARE = `vibeshare/${VERSION}`;

/** What a node publishes in `NodeInfoBase.protocol`: everything it still speaks. */
export function protocolRange(): { min: number; max: number } {
  return { min: PROTOCOL_MIN, max: PROTOCOL_VERSION };
}

export interface ProtocolVerdict {
  ok: boolean;
  /** When ok: the version both sides speak (the lower of the two maxima). */
  version?: number;
  /** When not ok: which side is out of range, and an honest message for the user. */
  code?: 'too-new' | 'too-old';
  message?: string;
  /** The range the node advertised (its bare `v` when it predates ranges). */
  node: { min: number; max: number };
}

/**
 * The compatibility matrix. Client and node work when their protocol ranges overlap
 * — v1 stays in every range, so today's nodes and clients keep talking to each other.
 * The negotiated version is the lower maximum. No overlap is a typed failure with an
 * honest message instead of a mysterious 400: `too-new` means the node dropped the
 * versions this build speaks (update the client), `too-old` means the opposite.
 * A node without `protocol` (anything before v2) advertises its bare `v` instead.
 */
export function negotiateProtocol(
  node: { min: number; max: number } | undefined,
  nodeV?: number,
  ours: { min: number; max: number } = protocolRange()
): ProtocolVerdict {
  const range = node ?? { min: nodeV ?? PROTOCOL_MIN, max: nodeV ?? PROTOCOL_MIN };
  if (range.min > ours.max) {
    return {
      ok: false,
      code: 'too-new',
      node: range,
      message: `This node speaks VibeShare protocol ${range.min}–${range.max}, but this side speaks ${ours.min}–${ours.max} — update the client to use this node.`,
    };
  }
  if (range.max < ours.min) {
    return {
      ok: false,
      code: 'too-old',
      node: range,
      message: `This node speaks VibeShare protocol ${range.min}–${range.max}, older than anything this side supports (${ours.min}–${ours.max}) — the node needs updating.`,
    };
  }
  return { ok: true, version: Math.min(range.max, ours.max), node: range };
}

export type FeatureValue = boolean | number | string | string[];
export type FeatureMap = Record<string, FeatureValue>;

/**
 * The machine-readable capability map of one node, derived from what its signed info
 * already advertises plus the fixed surfaces of its kind. Keys are stable strings;
 * readers MUST ignore keys they do not know, so forks can extend the map freely.
 */
export function featuresOf(info: NodeInfo): FeatureMap {
  const features: FeatureMap = {
    tracing: Boolean(info.tracing?.enabled),
    'page-limit-feed': PAGE_LIMITS.feed,
    'page-limit-search': PAGE_LIMITS.search,
    'page-limit-creators': PAGE_LIMITS.creators,
    'page-limit-catalog': PAGE_LIMITS.catalog,
  };
  if (info.type === 'provider') {
    const provider = info as ProviderInfo;
    features['storage-service'] = provider.services?.storage.enabled ?? false;
    features['storage-open-jobs'] = provider.services?.storage.openJobs ?? 0;
    // The largest upload a client may push here — the "max body size" of this node.
    features['upload-max-bytes'] = provider.pricing?.upload.maxBytes ?? 0;
    features.vvsh = true; // .vvsh objects, streams and conversion are a fixed provider surface
    features['content-urls'] = true; // client-hosted content URLs likewise
  } else {
    const algorithm = info as AlgorithmInfo;
    features.comments = true; // comment chains are a fixed algorithm surface
    features.claims = true; // as are platform-metric claims (/v1/claims)
    features['suggestion-kinds'] = [...SUGGESTION_KINDS];
    features.ranking = algorithm.ranking?.strategy ?? '';
    features.topics = algorithm.taxonomy?.topics.length ?? 0;
    features.discovery = Boolean(algorithm.discovery?.crawling);
    features['searches-platforms'] = Boolean(algorithm.discovery?.searchesPlatforms);
    features['discovery-platforms'] = [...(algorithm.discovery?.platforms ?? [])];
    features.bloom = Boolean(algorithm.bloom);
    features['bloom-inline-max-bits'] = algorithm.bloom?.inlineMaxBits ?? 0;
    features['bloom-account-max-bits'] = algorithm.bloom?.accountMaxBits ?? 0;
    features['bloom-tiers'] = (algorithm.bloom?.storage.tiers ?? []).map((tier) => tier.id);
  }
  return features;
}

/**
 * Fills in the additive v2 fields the moment a node assembles its signed info: the
 * protocol range it speaks and its capability map. Everything else in the info is
 * left exactly as given, so the signature covers the new members like any others.
 */
export function enrichNodeInfo<T extends NodeInfo>(info: T): T {
  return { ...info, protocol: protocolRange(), features: featuresOf(info) };
}
