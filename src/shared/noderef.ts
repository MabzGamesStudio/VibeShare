// Copy-pastable node references. Browser-safe: no Node imports.
//
//   vs:provider:vk1abc…@https://cdn.example.org
//   vs:algorithm:vk1xyz…@http://203.0.113.7:7702
//
// The key id pins the node: the client checks that the node's signed info was
// signed by that key, so a hijacked domain cannot pose as the node. A bare URL
// (https://cdn.example.org) also works; the type and key are then learnt from
// the node itself on first contact.

export const NODE_TYPES = ['provider', 'algorithm'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

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

const REF_RE = /^vs:(provider|algorithm):(vk1[a-z2-7]{52})@(.+)$/i;

export function parseNodeRef(text: string): NodeRef | null {
  const trimmed = text.trim().replace(/^vibeshare:\/\//i, '');
  const match = trimmed.match(REF_RE);
  if (match) {
    const url = normalizeNodeUrl(match[3]);
    return url ? { type: match[1].toLowerCase() as NodeType, id: match[2].toLowerCase(), url } : null;
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
