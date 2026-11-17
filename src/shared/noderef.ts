// Copy-pastable node references. Browser-safe: no Node imports.
//
//   vs:provider:vk1abc…@https://cdn.example.org
//   vs:algorithm:vk1xyz…@http://203.0.113.7:7702
//
// The key id pins the node: the client checks that the node's signed info was
// signed by that key, so a hijacked domain cannot pose as the node. A bare URL
// (https://cdn.example.org) also works; the type and key are then learnt from
// the node itself on first contact.
//
// Both halves of a reference are open registries: the node kinds (`provider`,
// `algorithm`, and whatever a fork registers) and the key algorithms their ids
// are public keys of (`vk1`, Ed25519). The parser reads the registries, so a
// fork adds a kind (`storage`, `relay`, `index`…) or a key format without
// touching anything here — registerSource…/registerKeyAlgorithm at start-up.
import { base32Encode } from './encoding.js';

/** A node kind a reference can name. */
export interface NodeTypeDef {
  /** The kind as it appears in a reference: `vs:<type>:<key>@<url>`. */
  id: string;
  label: string;
  description?: string;
}

const NODE_TYPE_REGISTRY = new Map<string, NodeTypeDef>();

/** Registers a node kind (or replaces one of the same id). Ids are case-insensitive. */
export function registerNodeType(def: NodeTypeDef): void {
  const id = String(def.id ?? '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Not a node type id: ${def.id}`);
  NODE_TYPE_REGISTRY.set(id, { ...def, id });
}

/** Every registered node kind, in registration order (the built-ins first). */
export function nodeTypes(): NodeTypeDef[] {
  return [...NODE_TYPE_REGISTRY.values()];
}

/** The registered kind of an id (case-insensitive), if there is one. */
export function nodeTypeOf(id: string): NodeTypeDef | undefined {
  return NODE_TYPE_REGISTRY.get(String(id ?? '').trim().toLowerCase());
}

const BUILTIN_NODE_TYPES = ['provider', 'algorithm'] as const;

/** The node kinds this build ships; registered kinds may add more (see NodeType). */
export type KnownNodeType = (typeof BUILTIN_NODE_TYPES)[number];

/** A node kind: one of the built-ins, or any kind a fork registered. */
export type NodeType = KnownNodeType | (string & {});

/**
 * The key algorithm a node's id is a public key of. Key ids carry their algorithm's
 * prefix (`vk1…`), so the right algorithm is found by prefix and validates its own.
 */
export interface KeyAlgorithm {
  /** The prefix every key id of this algorithm carries, e.g. `vk1`. */
  prefix: string;
  /** What the algorithm is called, e.g. Ed25519. */
  label: string;
  /** The length in bytes of the public key the id encodes. */
  bytes: number;
  /** Whether an id is a well-formed key id of this algorithm (lower-case input). */
  validate(id: string): boolean;
  /** A fresh random key id of this algorithm. */
  generate(): string;
}

const KEY_ALGORITHMS = new Map<string, KeyAlgorithm>();

/** Registers a key algorithm (or replaces one of the same prefix). */
export function registerKeyAlgorithm(algorithm: KeyAlgorithm): void {
  const prefix = String(algorithm.prefix ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(prefix)) throw new Error(`Not a key prefix: ${algorithm.prefix}`);
  KEY_ALGORITHMS.set(prefix, { ...algorithm, prefix });
}

/** Every registered key algorithm, in registration order (the built-ins first). */
export function keyAlgorithms(): KeyAlgorithm[] {
  return [...KEY_ALGORITHMS.values()];
}

/** The algorithm a key id belongs to, found by its prefix. */
export function keyAlgorithmOf(id: string): KeyAlgorithm | undefined {
  const key = String(id ?? '').toLowerCase();
  for (const algorithm of KEY_ALGORITHMS.values()) {
    if (key.startsWith(algorithm.prefix)) return algorithm;
  }
  return undefined;
}

// The built-ins: vk1 is an Ed25519 public key, base32-encoded (32 bytes → 52 chars).
registerNodeType({ id: 'provider', label: 'Content provider', description: 'Serves content and storage jobs.' });
registerNodeType({ id: 'algorithm', label: 'Search algorithm', description: 'Serves feeds, search and discovery.' });
registerKeyAlgorithm({
  prefix: 'vk1',
  label: 'Ed25519',
  bytes: 32,
  validate: (id) => /^vk1[a-z2-7]{52}$/.test(id),
  generate: () => {
    const key = new Uint8Array(32);
    globalThis.crypto.getRandomValues(key);
    return `vk1${base32Encode(key)}`;
  },
});

export interface NodeRef {
  type?: NodeType;
  id?: string;
  url: string;
}

export function normalizeNodeUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

export function formatNodeRef(ref: { type: NodeType; id: string; url: string }): string {
  return `vs:${ref.type}:${ref.id}@${ref.url}`;
}

// `vs:<type>:<key>@<url>` — the type and key are then checked against the registries,
// which is what keeps a reference of an unregistered kind or key format out.
const REF_RE = /^vs:([^:]+):([^@]+)@(.+)$/i;

export function parseNodeRef(text: string): NodeRef | null {
  const trimmed = text.trim().replace(/^vibeshare:\/\//i, '');
  const match = trimmed.match(REF_RE);
  if (match) {
    const type = match[1].toLowerCase();
    const id = match[2].toLowerCase();
    const url = normalizeNodeUrl(match[3]);
    const algorithm = keyAlgorithmOf(id);
    if (!url || !nodeTypeOf(type) || !algorithm || !algorithm.validate(id)) return null;
    return { type, id, url };
  }
  const url = normalizeNodeUrl(trimmed);
  return url ? { url } : null;
}

/** Parses any pasted text: one reference per line, or separated by spaces or commas. */
export function parseNodeRefs(text: string): { refs: NodeRef[]; invalid: string[] } {
  const refs: NodeRef[] = [];
  const invalid: string[] = [];
  for (const piece of text.split(/[\s,]+/).filter(Boolean)) {
    const ref = parseNodeRef(piece);
    if (ref) refs.push(ref);
    else invalid.push(piece);
  }
  return { refs, invalid };
}
