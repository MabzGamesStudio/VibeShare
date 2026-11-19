// Generates src/shared/clientapi.generated.ts: the client's local /api/* surface as
// typed data, straight from the route table in src/client/api.ts.
//
// WHY: the GUI, the daemon and the web service-worker backend all call the local API by
// hand, so a route that moves, vanishes or changes shape is only noticed at runtime.
// The generated module gives every caller one import for the paths and their declared
// request/response types, and `npm test` regenerates this in memory and fails whenever
// the checked-in copy is out of date — a stale route table becomes a test failure.
//
// The request/response types below are the DECLARED contract of each route (named types
// from clientapi.ts/protocol.ts where they fit, the handler's own shape where it is
// inline, `unknown` where the route proxies a node's response). They stay honest two
// ways: every type name must resolve (the generated module typechecks), and every route
// in the table must have an entry here (and vice versa) — the generator fails on any
// mismatch, so a new route cannot slip in without declaring its contract.
//
// Run `npm run generate:api` to rewrite the generated module after changing the route
// table or this file.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { clientRoutePaths, type RoutePath } from '../src/client/api.js';

/** The declared wire contract of one route: what a caller sends and gets back. */
interface RouteTypes {
  /** The request body type expression (`void` when the route takes no body). */
  request: string;
  /** The response type expression (`unknown` when the route proxies a node's shape). */
  response: string;
}

/** Where a type name used in the table below lives, for the generated imports. */
const TYPE_SOURCES: Record<string, string> = {
  // clientapi.ts — the client's own view of its data
  ClientState: './clientapi.js',
  NodeEntry: './clientapi.js',
  Settings: './clientapi.js',
  FeedResponse: './clientapi.js',
  ContentView: './clientapi.js',
  CreatorView: './clientapi.js',
  GroupView: './clientapi.js',
  TopicView: './clientapi.js',
  CommentsResponse: './clientapi.js',
  CommentPostRequest: './clientapi.js',
  BloomStatus: './clientapi.js',
  SavedState: './clientapi.js',
  ProfileSummary: './clientapi.js',
  ToastMessage: './clientapi.js',
  SearchHistoryItem: './clientapi.js',
  Job: './clientapi.js',
  PublishRequest: './clientapi.js',
  PublishPreview: './clientapi.js',
  ExternalPublishRequest: './clientapi.js',
  Subscription: './clientapi.js',
  LibraryItem: './clientapi.js',
  HistoryItem: './clientapi.js',
  PageSource: './clientapi.js',
  PageFilters: './clientapi.js',
  // protocol.ts — the wire types shared with nodes
  Invoice: './protocol.js',
  PaymentReceipt: './protocol.js',
  TopicInfo: './protocol.js',
  TopicCreateRequest: './protocol.js',
  TopicCreateResponse: './protocol.js',
  GroupSuggestion: './protocol.js',
  GroupSuggestionRequest: './protocol.js',
  GroupSuggestionResponse: './protocol.js',
  TopicSuggestion: './protocol.js',
  TopicSuggestionRequest: './protocol.js',
  TopicSuggestionResponse: './protocol.js',
  CreatorInfo: './protocol.js',
  CreatorIconResponse: './protocol.js',
  CreatorIconSuggestion: './protocol.js',
  CreatorContentResponse: './protocol.js',
  CreatorContentSuggestion: './protocol.js',
  AccountLinkProposal: './protocol.js',
  AccountLinkResponse: './protocol.js',
  Preferences: './protocol.js',
  BloomStorageState: './protocol.js',
  AccountFilterState: './protocol.js',
  // the .vvsh stream format
  VvshFile: './vvsh.js',
  VvshConvertQuote: './vvsh.js',
  VvshFrameStats: './vvsh.js',
  VvshBuildConfig: './vvsh-encode.js',
  Manifest: './content.js',
};

/**
 * The contract table, keyed by "METHOD /path" exactly as the route table registers it.
 * A route without an entry (or an entry without a route) fails the generator.
 */
const API_TYPES: Record<string, RouteTypes> = {
  'GET /api/version': { request: 'void', response: '{ version: number }' },
  'GET /api/state': { request: 'void', response: 'ClientState' },
  'POST /api/credits/transfer': {
    request: '{ nodeId: string; to: string; amount: number }',
    response: '{ transfer: { from: string; to: string; toName?: string; amount: number; balance: number; minSenderBalance: number } }',
  },
  'POST /api/nodes': { request: '{ text?: string }', response: '{ added: NodeEntry[]; errors: { ref: string; error: string }[] }' },
  'GET /api/nodes/export': { request: 'void', response: '{ text: string }' },
  'PATCH /api/nodes/:id': { request: 'Partial<NodeEntry>', response: 'NodeEntry' },
  'DELETE /api/nodes/:id': { request: 'void', response: '{ ok: true }' },
  'POST /api/nodes/order': { request: "{ type?: 'provider' | 'algorithm'; ids?: string[] }", response: '{ nodes: NodeEntry[] }' },
  'POST /api/nodes/:id/refresh': { request: 'void', response: 'NodeEntry' },
  'POST /api/nodes/refresh': { request: 'void', response: '{ nodes: NodeEntry[] }' },
  'GET /api/nodes/:id/account': { request: 'void', response: '{ account: { balance: number; id: string } }' },
  // The node's own response shapes (proxied through): declared as unknown rather than
  // restated here, so the node API can evolve without lying in this contract.
  'GET /api/nodes/:id/content-urls': { request: 'void', response: 'unknown' },
  'GET /api/nodes/:id/tier/:cid': { request: 'void', response: 'unknown' },
  'POST /api/nodes/:id/tier/:cid': { request: '{ tier?: string; extendDays?: number }', response: 'unknown' },
  'GET /api/nodes/:id/storage-jobs': {
    request: 'void',
    response: "{ items: { cid: string; title?: string; bytes: number; jobId: string; source: 'open job' | 'your assignment'; earned?: number }[] }",
  },
  'POST /api/nodes/:id/content-urls': {
    request: '{ items?: { cid?: string; url?: string; baseUrl?: string }[] }',
    response: '{ results: unknown[] }',
  },
  'POST /api/nodes/:id/content-urls/fetch': { request: '{ cid?: string }', response: 'unknown' },
  'GET /api/dev/info': { request: 'void', response: '{ dev: boolean }' },
  'GET /api/nodes/:id/dev-host': { request: 'void', response: 'unknown' },
  'POST /api/nodes/:id/dev-host': { request: '{ cid?: string; data?: string }', response: 'unknown' },
  'GET /api/nodes/:id/payments': { request: 'void', response: 'unknown' },
  'POST /api/nodes/:id/invoices': { request: '{ method?: string; credits?: number }', response: 'Invoice' },
  'GET /api/nodes/:id/invoices/:invoice': { request: 'void', response: 'Invoice' },
  'POST /api/nodes/:id/claim': { request: '{ method?: string } & Record<string, unknown>', response: '{ balance: number }' },
  'GET /api/receipts': { request: 'void', response: '{ receipts: (PaymentReceipt & { savedAt: string; verified: boolean })[] }' },
  'DELETE /api/receipts/:id': { request: 'void', response: '{ removed: boolean }' },
  'POST /api/lookup': { request: '{ ids?: string[] }', response: '{ known: Record<string, boolean> }' },
  'POST /api/feed': {
    request: "{ cursor?: string; seed?: string; formats?: Preferences['formats'] }",
    response: 'FeedResponse',
  },
  'POST /api/search': {
    request: '{ query?: string; filters?: Preferences & { creator?: string; platform?: string }; sort?: string; cursor?: string; seed?: string; trace?: string }',
    response: 'FeedResponse',
  },
  'POST /api/browse': {
    request: '{ source?: PageSource; query?: string; filters?: Partial<PageFilters>; sort?: string; cursor?: string; seed?: string }',
    response: 'FeedResponse',
  },
  'POST /api/report': {
    request: '{ id?: string }',
    response: '{ nodes: { node: string; name: string; known?: boolean; credited?: number; error?: string }[] }',
  },
  'POST /api/claim': {
    request: '{ id?: string; source?: string; metrics?: Record<string, number>; publishedAt?: string }',
    response: '{ nodes: { node: string; name: string; newInfo?: boolean; credited?: number; multiplier?: number; updated?: string[]; error?: string }[] }',
  },
  'POST /api/subscriptions/feed': { request: '{ cursor?: string }', response: 'FeedResponse' },
  'GET /api/content/:id': { request: 'void', response: 'ContentView' },
  'GET /api/creators/:id': { request: 'void', response: 'CreatorView' },
  'GET /api/comments/:id': { request: 'void', response: 'CommentsResponse' },
  'POST /api/comments/:id': { request: 'CommentPostRequest', response: 'unknown' },
  'POST /api/comments/:id/:comment/vote': { request: '{ vote?: number }', response: 'unknown' },
  'POST /api/comments/:id/:comment/remove': { request: 'void', response: 'unknown' },
  'GET /api/creators': { request: 'void', response: '{ creators: CreatorInfo[] }' },
  'GET /api/groups/:id': { request: 'void', response: 'GroupView' },
  'GET /api/topics': { request: 'void', response: '{ topics: TopicInfo[] }' },
  'GET /api/topics/:id': { request: 'void', response: 'TopicView' },
  'POST /api/topics': { request: '{ nodeId?: string; name?: string; description?: string }', response: 'TopicCreateResponse' },
  'POST /api/groups/suggestions': {
    request: '{ nodeId?: string; group?: string; add?: string[]; remove?: string[]; name?: string; description?: string; links?: string[]; icon?: string; reason?: string }',
    response: 'GroupSuggestionResponse',
  },
  'GET /api/groups/suggestions/:id': { request: 'void', response: '{ suggestions: GroupSuggestion[] }' },
  'POST /api/topics/suggestions': {
    request: '{ nodeId?: string; topic?: string; description?: string; icon?: string; reason?: string }',
    response: 'TopicSuggestionResponse',
  },
  'GET /api/topics/suggestions/:id': { request: 'void', response: '{ suggestions: TopicSuggestion[] }' },
  'PUT /api/creators/accounts': {
    request: '{ nodeId?: string; creator?: string; accounts?: { platform: string; handle: string; url?: string; creator?: string; subscribers?: number }[]; name?: string; kind?: string; sign?: boolean; symmetric?: boolean }',
    response: 'AccountLinkResponse',
  },
  'GET /api/account-links/:id': { request: 'void', response: '{ proposals: AccountLinkProposal[] }' },
  'POST /api/creator-suggestions': {
    request: '{ nodeId?: string; creator?: string; id?: string; message?: string; title?: string; platform?: string; metrics?: Record<string, number> }',
    response: 'CreatorContentResponse',
  },
  'GET /api/creator-suggestions/:id': { request: 'void', response: '{ suggestions: CreatorContentSuggestion[] }' },
  'POST /api/creator-icons': { request: '{ nodeId?: string; creator?: string; icon?: string }', response: 'CreatorIconResponse' },
  'GET /api/creator-icons/:id': { request: 'void', response: '{ suggestions: CreatorIconSuggestion[] }' },
  'POST /api/vote': { request: '{ nodeId?: string; id?: string; vote?: number }', response: '{ credited: number }' },
  'GET /api/vote/:id': { request: 'void', response: 'unknown' },
  'POST /api/suggest': {
    request: '{ nodeId?: string; id?: string; kind?: string; value?: string; reason?: string; timestamp?: number; platform?: string }',
    response: '{ status: string }',
  },
  'POST /api/suggest/provider': {
    request: '{ nodeId?: string; id?: string; kind?: string; sources?: { platform: string; url: string }[]; duplicateOf?: string; note?: string }',
    response: 'unknown',
  },
  'GET /api/contributions': { request: 'void', response: 'unknown' },
  'GET /api/subscriptions': { request: 'void', response: '{ subscriptions: Subscription[] }' },
  'POST /api/subscriptions': { request: '{ id?: string; name?: string; kind?: string; icon?: string }', response: 'unknown' },
  'DELETE /api/subscriptions/:id': { request: 'void', response: 'unknown' },
  'POST /api/publish': { request: 'PublishRequest', response: 'unknown' },
  'POST /api/publish/preview': { request: 'PublishRequest', response: 'PublishPreview' },
  'POST /api/upload/url': { request: '{ url?: string }', response: '{ fileId: string; size: number; name: string; mime: string }' },
  'POST /api/content-link': { request: '{ url?: string; cid?: string }', response: '{ ok: boolean; size: number; error?: string }' },
  'POST /api/publish/external': { request: 'ExternalPublishRequest', response: 'unknown' },
  'GET /api/jobs': { request: 'void', response: '{ jobs: Job[] }' },
  'GET /api/jobs/:id': { request: 'void', response: 'Job' },
  'GET /api/library': { request: 'void', response: '{ published: LibraryItem[]; history: HistoryItem[] }' },
  'POST /api/history': { request: '{ id?: string; title?: string; contentId?: string; link?: string }', response: 'unknown' },
  'DELETE /api/history': { request: 'void', response: 'unknown' },
  'GET /api/search-history': { request: 'void', response: '{ items: SearchHistoryItem[] }' },
  'DELETE /api/search-history': { request: '{ query?: string }', response: '{ items: SearchHistoryItem[] }' },
  'GET /api/toasts': { request: 'void', response: '{ items: ToastMessage[]; saved: boolean }' },
  'POST /api/toasts': { request: '{ text?: string; kind?: string; at?: string }', response: '{ items: ToastMessage[]; saved: boolean }' },
  'DELETE /api/toasts': { request: 'void', response: '{ items: ToastMessage[]; saved: boolean }' },
  'DELETE /api/toasts/:id': { request: 'void', response: '{ items: ToastMessage[]; saved: boolean }' },
  'GET /api/saved': { request: 'void', response: 'SavedState' },
  'POST /api/saved': { request: '{ id?: string; title?: string; collections?: unknown }', response: 'SavedState' },
  'PATCH /api/saved/:id': { request: '{ title?: string; collections?: unknown }', response: 'SavedState' },
  'DELETE /api/saved/:id': { request: 'void', response: 'SavedState' },
  'POST /api/cid-collections': { request: '{ name?: string }', response: 'SavedState' },
  'PATCH /api/cid-collections/:id': { request: '{ name?: string }', response: 'SavedState' },
  'DELETE /api/cid-collections/:id': { request: 'void', response: 'SavedState' },
  'GET /api/bloom': { request: 'void', response: 'BloomStatus' },
  'POST /api/bloom/mark': {
    request: '{ scope?: string; id?: string; contentId?: string; link?: string }',
    response: '{ added: number }',
  },
  'POST /api/bloom/reset': { request: '{ scope?: string }', response: 'BloomStatus' },
  'GET /api/bloom/offers/:id': { request: 'void', response: 'BloomStorageState' },
  'POST /api/bloom/storage/:id': { request: '{ tier?: string }', response: 'BloomStorageState' },
  'DELETE /api/bloom/storage/:id': { request: 'void', response: 'BloomStorageState' },
  'GET /api/bloom/account/:id': { request: 'void', response: 'AccountFilterState' },
  'POST /api/bloom/account': {
    request: 'void',
    response: '{ results: { node: string; name: string; ok: boolean; error?: string; updatedAt?: string }[] }',
  },
  'POST /api/bloom/account/:id': { request: 'void', response: 'AccountFilterState' },
  'DELETE /api/bloom/account/:id': { request: 'void', response: 'AccountFilterState' },
  'GET /api/vvsh/encoder': { request: 'void', response: "{ backend: 'ffmpeg' | 'mediarecorder'; warning?: string }" },
  'POST /api/vvsh/session': {
    request: '{ mode?: string; nodeId?: string; name?: string; totalSeconds?: number; config?: VvshBuildConfig; meta?: Record<string, unknown>; sourceMime?: string; previews?: string[]; encoder?: \'ffmpeg\'; sources?: string[]; algorithms?: string[]; sign?: boolean; thumbnail?: string; createdAt?: string }',
    response: '{ jobId: string }',
  },
  'POST /api/vvsh/session/:id/piece': { request: '{ data?: string; index?: number }', response: '{ bytes: number; duplicate?: boolean }' },
  'GET /api/vvsh/session/:id': {
    request: 'void',
    response: "{ jobId: string; status: 'running' | 'done' | 'error'; attempts: number; warnings: string[]; cid?: string; manifest?: Manifest; listed?: number; quote?: VvshConvertQuote; error?: string; progress?: number }",
  },
  'POST /api/vvsh/session/:id/finish': {
    request: 'void',
    response: "{ jobId: string; status: 'running' | 'done' | 'error'; attempts: number; warnings: string[]; cid?: string; manifest?: Manifest; listed?: number; quote?: VvshConvertQuote; error?: string; progress?: number }",
  },
  'POST /api/vvsh/quote': {
    request: '{ nodeId?: string; bytes?: number; totalSeconds?: number; config?: VvshBuildConfig }',
    response: '{ quote: VvshConvertQuote }',
  },
  'POST /api/vvsh/chunk': {
    request: '{ nodeId?: string; root?: string; chunkCount?: number; file?: VvshFile; index?: number; rendition?: string; from?: { hash: string; depth: number } }',
    response: '{ data: string; frames: VvshFrameStats; path: string[]; pathDepth: number }',
  },
  'POST /api/vvsh/export': {
    request: '{ nodeId?: string; file?: VvshFile; rendition?: string; name?: string }',
    response: '{ data: string; name: string }',
  },
  'POST /api/vvsh/object': { request: '{ nodeId?: string; hash?: string }', response: '{ data: string }' },
  'PUT /api/vvsh/object': { request: '{ nodeId?: string; hash?: string; data?: string }', response: '{ ok: true }' },
  'POST /api/vvsh/manifest': {
    request: '{ nodeId?: string; manifest?: Record<string, unknown>; algorithms?: string[]; sign?: boolean; thumbnail?: string; sources?: string[] }',
    response: 'unknown',
  },
  'PATCH /api/settings': { request: 'Partial<Settings>', response: 'Settings' },
  'GET /api/profiles': { request: 'void', response: '{ profiles: ProfileSummary[]; active: string }' },
  'POST /api/profiles': {
    request: '{ name?: string; username?: string; password?: string; hidden?: boolean }',
    response: '{ profiles: ProfileSummary[] }',
  },
  'POST /api/profiles/unlock': { request: '{ username?: string; password?: string }', response: 'ClientState' },
  'PATCH /api/profiles/:id': {
    request: '{ name?: string; username?: string; password?: string; makePublic?: boolean }',
    response: '{ profiles: ProfileSummary[] }',
  },
  'DELETE /api/profiles/:id': { request: '{ username?: string; password?: string }', response: '{ profiles: ProfileSummary[] }' },
  'POST /api/profiles/:id/switch': { request: '{ username?: string; password?: string }', response: 'ClientState' },
  'GET /api/identity/export': { request: 'void', response: '{ seed: string; id: string }' },
  'POST /api/identity/import': { request: '{ seed?: string }', response: '{ id: string }' },
  'GET /api/cache': { request: 'void', response: '{ bytes: number; chunks: number; limit: number }' },
  'DELETE /api/cache': { request: 'void', response: '{ bytes: number; chunks: number }' },
};

/** The stable key of a route in the generated map: 'get-content-id' for GET /api/content/:id. */
export function routeKey(method: string, path: string): string {
  return `${method.toLowerCase()}-${path.replace(/^\/api\//, '').replace(/[/]+/g, '-').replace(/:([A-Za-z0-9_]+)/g, '$1')}`;
}

/** TypeScript's own utility and built-in type names: never imported by the generated module. */
const BUILT_IN_TYPES = new Set([
  'Array',
  'Awaited',
  'ConstructorParameters',
  'Date',
  'Exclude',
  'Extract',
  'InstanceType',
  'Map',
  'NonNullable',
  'Omit',
  'Parameters',
  'Partial',
  'Pick',
  'Promise',
  'Readonly',
  'Record',
  'ReturnType',
  'Set',
  'Uint8Array',
]);

/** Type names (capitalized identifiers) a type expression uses, minus built-ins. */
function typeNames(expression: string): string[] {
  const names = (expression.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? []).filter((name) => !BUILT_IN_TYPES.has(name));
  return [...new Set(names)];
}

/** Every name a type expression uses must be declared in TYPE_SOURCES. */
function checkTypeNames(expression: string, where: string): void {
  for (const name of typeNames(expression)) {
    if (!(name in TYPE_SOURCES)) throw new Error(`${where}: unknown type name ${name} — add it to TYPE_SOURCES`);
  }
}

/**
 * Builds the whole generated module as text. Deterministic: the same route table and
 * contract always produce byte-identical output (the drift test compares it exactly).
 */
export function generateApiSource(routes: RoutePath[] = clientRoutePaths()): string {
  const seen = new Set<string>();
  const entries: { key: string; method: string; path: string; types: RouteTypes }[] = [];
  for (const { method, path } of routes) {
    const where = `${method} ${path}`;
    const key = routeKey(method, path);
    if (seen.has(key)) throw new Error(`two routes share the key ${key}`);
    seen.add(key);
    const types = API_TYPES[where];
    if (!types) throw new Error(`no contract entry for ${where} — add it to API_TYPES and re-run \`npm run generate:api\``);
    checkTypeNames(types.request, where);
    checkTypeNames(types.response, where);
    entries.push({ key, method, path, types });
  }
  for (const where of Object.keys(API_TYPES)) {
    if (!entries.some((entry) => `${entry.method} ${entry.path}` === where)) {
      throw new Error(`contract entry ${where} has no route in the table — remove it or fix the path`);
    }
  }

  // The imports the type expressions need, grouped by module and sorted.
  const used = new Set(entries.flatMap((entry) => [...typeNames(entry.types.request), ...typeNames(entry.types.response)]));
  const byModule = new Map<string, string[]>();
  for (const name of used) {
    const module = TYPE_SOURCES[name];
    const list = byModule.get(module) ?? [];
    list.push(name);
    byModule.set(module, list);
  }
  const imports = [...byModule.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([module, names]) => `import type { ${names.sort().join(', ')} } from '${module}';`)
    .join('\n');

  const spec = entries
    .map((entry) => `  '${entry.key}': { method: '${entry.method}'; path: '${entry.path}'; request: ${entry.types.request}; response: ${entry.types.response} };`)
    .join('\n');
  const map = entries.map((entry) => `  '${entry.key}': { method: '${entry.method}', path: '${entry.path}' },`).join('\n');

  return `// GENERATED by \`npm run generate:api\` (scripts/generate-api-client.ts) — DO NOT EDIT.
//
// The client's local /api/* surface as typed data, built from the route table in
// src/client/api.ts and the declared contract in the generator. Every caller takes its
// paths and request/response types from here, so a route that moves or vanishes is a
// compile error instead of a runtime surprise. \`npm test\` regenerates this module in
// memory and fails when this checked-in copy is out of date: change the route table or
// the generator's contract, run \`npm run generate:api\`, and commit the result.
${imports}

/** The declared wire contract of every client API route. */
export interface ClientApiSpec {
${spec}
}

/** The route table as runtime data: method and literal path per route. */
export const CLIENT_API: { [K in keyof ClientApiSpec]: { method: ClientApiSpec[K]['method']; path: ClientApiSpec[K]['path'] } } = {
${map}
};

export type ClientApiRoute = keyof ClientApiSpec;
/** What a route's request body looks like (void: the route takes no body). */
export type ClientApiRequest<K extends ClientApiRoute> = ClientApiSpec[K]['request'];
/** What a route answers with. */
export type ClientApiResponse<K extends ClientApiRoute> = ClientApiSpec[K]['response'];

/** A typed caller for the client API: one call per route, typed both ways. */
export interface ClientApiCaller {
  <K extends ClientApiRoute>(route: K, init?: { body?: ClientApiRequest<K>; query?: Record<string, string | number | undefined> }): Promise<ClientApiResponse<K>>;
}

/** Fills a route's :params — clientApiPath('get-content-id', { id: 'vs1…' }). */
export function clientApiPath<K extends ClientApiRoute>(route: K, params: Record<string, string> = {}): string {
  return CLIENT_API[route].path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? \`:\${name}\`));
}
`;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const target = new URL('../src/shared/clientapi.generated.ts', import.meta.url);
  writeFileSync(target, generateApiSource());
  console.log(`wrote ${target.pathname}`);
}
