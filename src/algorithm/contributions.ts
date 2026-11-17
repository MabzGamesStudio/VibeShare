// What a client suggestion or submission looks like on disk, and how the values
// clients bring are checked before they are kept.

import { badRequest } from '../shared/node/http.js';
import { type AccountLinkProposal, type CreatorContentSuggestion, type CreatorIconSuggestion, type GroupSuggestion, type SubmissionRequest, type SuggestionKind, type TopicSuggestion } from '../shared/protocol.js';
import { FORMATS, type Format, RATINGS, type Rating, normalizeTag } from '../shared/taxonomy.js';
import { identityOf, normalizeLink } from './registry.js';

export interface Suggestion {
  id: string;
  contentId: string;
  kind: SuggestionKind;
  value: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  /** Everyone who made this same suggestion, with their reason and evidence. */
  votes: { account: string; reason: string; timestamp?: number; at: string; platform?: string }[];
}
export interface Submission {
  id: string;
  contentId: string;
  accountId: string;
  request: Omit<SubmissionRequest, 'thumbnail' | 'creatorProof'>;
  verifiedCreator?: string;
  hasThumbnail: boolean;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  note?: string;
}
export interface ContributionData {
  votes: Record<string, Record<string, 1 | -1>>;
  suggestions: Record<string, Suggestion>;
  submissions: Record<string, Submission>;
  /** Content clients suggested as related to a creator, waiting for the operator. */
  creatorSuggestions: Record<string, CreatorContentSuggestion>;
  /** Icons clients suggested for a creator, waiting for the operator. */
  iconSuggestions: Record<string, CreatorIconSuggestion>;
  /** Unsigned account links clients proposed for a creator, waiting for the operator. */
  accountLinks: Record<string, AccountLinkProposal>;
  /** Changes clients suggested for a group (members, name, description, links, icon). */
  groupSuggestions: Record<string, GroupSuggestion>;
  /** Descriptions and icons clients suggested for a topic. */
  topicSuggestions: Record<string, TopicSuggestion>;
}
export function validateSuggestion(kind: SuggestionKind, raw: string): string {
  const value = raw.trim();
  switch (kind) {
    case 'format':
      if (!FORMATS.includes(value as Format)) throw badRequest(`Unknown format ${value}`);
      return value;
    case 'rating':
      if (!RATINGS.includes(value as Rating)) throw badRequest(`Unknown rating ${value}`);
      return value;
    case 'topic': {
      const tag = normalizeTag(value);
      if (!tag) throw badRequest('Empty tag');
      return tag;
    }
    case 'creator': {
      if (!value || value.length > 120) throw badRequest('A creator name is required (at most 120 characters)');
      return value;
    }
    case 'published': {
      const time = Date.parse(value);
      if (!Number.isFinite(time)) throw badRequest('A publish time is a date like 2024-05-01 or 2024-05-01T12:00:00Z');
      if (time > Date.now() + 86_400_000) throw badRequest('A publish time cannot be in the future');
      return new Date(time).toISOString();
    }
    case 'report':
      return value.slice(0, 64) || 'other';
    case 'source': {
      // A link to the content on another platform; one content id can carry several.
      return normalizeLink(value);
    }
    case 'duplicate': {
      const identity = identityOf({ id: value });
      return identity.key || value.slice(0, 4096);
    }
  }
}
/** Platform numbers a client saw (views, likes, comments…), cleaned for keeping. */
export function metricsOf(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 16)) {
    const name = key.trim().slice(0, 32);
    const number = Number(value);
    if (name && Number.isFinite(number) && number >= 0) metrics[name] = Math.min(number, 1e15);
  }
  return Object.keys(metrics).length ? metrics : undefined;
}
