// Content the client ships with: its full bytes live in the app itself, so these content
// ids always stream or download — with no provider node connected and nothing to fetch.
// Browser-safe: no Node imports.

/** The default article describing VibeShare, in full. */
export const ABOUT_VIBESHARE = `# VibeShare

VibeShare is a way to watch, listen to, read, publish and pay for content without any
central server. There is no VibeShare company in the middle: the software runs on the
machines of the people who use it, and those machines talk to each other directly.

## The three kinds of node

- The **client** is the app you use: it keeps your keys, your credits, your settings and
  your list of nodes, and it never polls anybody — it only asks nodes when you ask for
  something.
- **Content provider** nodes store the actual bytes and stream them out chunk by chunk,
  for credits they issue themselves. A provider keeps data on its own disks and buckets,
  on mirrors, and — paying for it — on the machines of users who let it.
- **Search algorithm** nodes decide what you see: they describe content (format, age
  rating, topics, creator), rank it however their operator likes, and answer searches.

## Content ids

Every piece of content has an id that is the hash of its own data: \`vs1…\`. Nobody can
publish bytes under an id that does not match them, and nobody has to be trusted to send
you the right file — your client checks every chunk against its hash as it arrives. The
id is also the address: any host that serves the bytes at \`<base>/<id>\` is a valid copy,
which is how one piece of content can live on many providers and mirrors at once.

## Credits

Credits are issued by provider nodes for the services they sell (storing and sending
bytes) and by algorithm nodes for the information they buy (votes, reports, metadata
corrections). Credits never move between nodes: each node keeps its own ledger, and you
earn and spend per node.

## Getting started

Add a few nodes on the Nodes page — references look like \`vs:provider:vk1…@https://…\`
and \`vs:algorithm:vk1…@https://…\` — then open a page. Everything else (publishing,
subscribing, earning by hosting content ids on free static hosts) is in the menus of the
app itself.

This article is stored inside the client: its content id always downloads here, whether
or not any node is connected.
`;

/** Content shipped inside the client, by content id. */
export interface BuiltinContent {
  name: string;
  mime: string;
  text: string;
}

const ABOUT: BuiltinContent = { name: 'about-vibeshare.md', mime: 'text/markdown', text: ABOUT_VIBESHARE };

/**
 * The content ids the client always has in full. The default article describing
 * VibeShare carries two ids in the wild; both download from here with no provider.
 */
export const BUILTIN_CONTENT: Record<string, BuiltinContent> = {
  'vs1dzk2bbtgf5yhq65ywnlk2rt6p2nl6gu222vcbo7wqr5kiriwbhyq': ABOUT,
  'vs1fvghgh33iz7bzlpv6manelcghldqf3fwjh7l57wnm3nj7br6aayq': ABOUT,
};

/** The client's own copy of a content id, when it ships with one. */
export function builtinContent(id: string): BuiltinContent | undefined {
  return BUILTIN_CONTENT[id.trim().replace(/^\/+/, '').split('~')[0]];
}

/** Its full bytes, ready to stream or download. */
export function builtinBytes(id: string): Uint8Array | undefined {
  const found = builtinContent(id);
  return found ? new TextEncoder().encode(found.text) : undefined;
}