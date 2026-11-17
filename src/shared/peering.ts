// One peering vocabulary for every node kind. Browser-safe: no Node imports.
//
// The two node kinds named the same two directions differently: content providers say
// `send`/`receive` (this node serves bytes to the peer / fetches bytes from it), while
// algorithm nodes say `fetch`/`serve` (this node asks the peer / the peer asks this node).
// Forks then had to learn both. A `PeerLink` is the neutral shape both sides map to:
//
//   outgoing — this node starts exchanges with the peer   (provider `send`, algorithm `fetch`)
//   incoming — the peer may start exchanges with this node (provider `receive`, algorithm `serve`)
//
// The handshake in PROTOCOL.md §5: a peer identifies itself with its node reference over
// an ordinary authenticated session (its key signs the login), the receiving node checks
// that key against its configured peer list, and the directions above decide which calls
// that session may make. Nothing here changes what a node sends today: it is a mapping
// layer so both kinds can speak one shape in admin UIs, docs and future configuration.

export type PeerDirection = 'outgoing' | 'incoming';

/** One peer relationship, in the vocabulary every node kind shares. */
export interface PeerLink {
  /** The peer's node reference (`vs:<type>:<key>@<url>`). */
  ref: string;
  /** Whether this node may start exchanges with the peer. */
  outgoing: boolean;
  /** Whether the peer may start exchanges with this node. */
  incoming: boolean;
  /** What travels in each direction, when the node kind says (providers: bytes; algorithms: metadata). */
  carries?: 'bytes' | 'metadata';
}

/** A provider's configured peer (`send` = we serve it, `receive` = we take from it). */
export function peerLinkFromProvider(peer: { ref: string; send: boolean; receive: boolean }): PeerLink {
  return { ref: peer.ref, outgoing: peer.send, incoming: peer.receive, carries: 'bytes' };
}

/** An algorithm node's configured peer (`fetch` = we ask it, `serve` = it may ask us). */
export function peerLinkFromAlgorithm(peer: { ref: string; fetch: boolean; serve: boolean }): PeerLink {
  return { ref: peer.ref, outgoing: peer.fetch, incoming: peer.serve, carries: 'metadata' };
}

/** The provider config shape, for writing a PeerLink back where a provider expects it. */
export function peerLinkToProvider(link: PeerLink): { ref: string; send: boolean; receive: boolean } {
  return { ref: link.ref, send: link.outgoing, receive: link.incoming };
}

/** The algorithm config shape, for writing a PeerLink back where an algorithm node expects it. */
export function peerLinkToAlgorithm(link: PeerLink): { ref: string; fetch: boolean; serve: boolean } {
  return { ref: link.ref, fetch: link.outgoing, serve: link.incoming };
}

/** One line describing a link, for admin lists and logs: "both ways", "outgoing only"… */
export function describePeerLink(link: PeerLink): string {
  if (link.outgoing && link.incoming) return 'both ways';
  if (link.outgoing) return 'outgoing only';
  if (link.incoming) return 'incoming only';
  return 'no exchange';
}

/** The directions a link carries, as a tuple — handy for filters and tests. */
export function peerDirections(link: PeerLink): PeerDirection[] {
  const out: PeerDirection[] = [];
  if (link.outgoing) out.push('outgoing');
  if (link.incoming) out.push('incoming');
  return out;
}
