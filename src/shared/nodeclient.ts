import { derivePseudonym, randomHex, signData, solveProofOfWork, verifySignature, type Identity } from './crypto.js';
import { canonicalJson } from './encoding.js';
import { request as send, RemoteError, type RequestOptions, type Transport } from './remote.js';
import type { NodeType } from './noderef.js';
import {
  infoSigningPayload,
  powInput,
  sessionSigningPayload,
  type NodeInfo,
  type SessionResponse,
  type SignedInfo,
} from './protocol.js';

/**
 * How a client holds its account on a node:
 *  - identity:  the user's main public key. Credits follow the user everywhere; nodes can link activity.
 *  - pseudonym: a key derived from the main key for this node only. Credits survive reinstalls
 *               (re-derived from the same backup) but nodes cannot link the user across nodes.
 *  - anonymous: a bearer token from the node. Nothing ties it to the user; lose it and the credits are gone.
 */
export type { AuthMode } from './clientapi.js';
import type { AuthMode } from './clientapi.js';

export interface StoredAccount {
  anonymousToken?: string;
  accountId?: string;
}

export interface NodeClientOptions {
  url: string;
  expectedId?: string;
  expectedType?: NodeType;
  auth: AuthMode;
  identity: Identity;
  account?: StoredAccount;
  /** Called when the client gets a new anonymous token, to persist it. */
  onAccount?: (account: StoredAccount) => void;
  /**
   * Called after every request: whether the node answered, how fast, and the account
   * balance when the node sent one (x-vs-balance). Clients learn node status and credits
   * from the requests they make anyway, instead of polling.
   */
  onResult?: (result: RequestResult) => void;
  timeoutMs?: number;
  /** How requests are sent, asked before each one (settings can change): Tor, or plain fetch when undefined. */
  transport?: () => Transport | undefined;
}

export interface RequestResult {
  /** The node answered (any HTTP status); false when it could not be reached. */
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  balance?: number;
}

function balanceOf(response: Response): number | undefined {
  const header = response.headers.get('x-vs-balance');
  const value = header === null ? NaN : Number(header);
  return Number.isFinite(value) ? value : undefined;
}

export function verifySignedInfo(signed: SignedInfo): boolean {
  return Boolean(
    signed?.info?.id && verifySignature(signed.info.id, infoSigningPayload(canonicalJson(signed.info)), signed.sig)
  );
}

export class NodeClient {
  info: NodeInfo | null = null;
  private session: { token: string; expires: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(public options: NodeClientOptions) {}

  get url(): string {
    return this.options.url;
  }

  private request(url: string, options: RequestOptions = {}): Promise<Response> {
    return send(url, { ...options, transport: this.options.transport?.() });
  }

  /** Fetches the node's signed info and checks it is the node the reference names. */
  /** Sends a request and reports how it went (see onResult). */
  private async observed(send: () => Promise<Response>): Promise<Response> {
    const started = Date.now();
    try {
      const response = await send();
      this.options.onResult?.({ reachable: true, latencyMs: Date.now() - started, balance: balanceOf(response) });
      return response;
    } catch (error) {
      const unreachable = !(error instanceof RemoteError) || error.status === 0;
      this.options.onResult?.(
        unreachable ? { reachable: false, error: (error as Error).message } : { reachable: true, latencyMs: Date.now() - started }
      );
      throw error;
    }
  }

  async fetchInfo(): Promise<NodeInfo> {
    const response = await this.observed(() => this.request(`${this.url}/v1/info`, { timeoutMs: this.options.timeoutMs ?? 10000 }));
    const signed = (await response.json()) as SignedInfo;
    if (!verifySignedInfo(signed)) throw new RemoteError(0, 'bad_signature', 'The node info is not signed by its key');
    if (this.options.expectedId && signed.info.id !== this.options.expectedId) {
      throw new RemoteError(0, 'wrong_node', `Expected node ${this.options.expectedId.slice(0, 12)}…, got ${signed.info.id.slice(0, 12)}…`);
    }
    if (this.options.expectedType && signed.info.type !== this.options.expectedType) {
      throw new RemoteError(0, 'wrong_type', `This is a ${signed.info.type} node, not a ${this.options.expectedType} node`);
    }
    this.info = signed.info;
    return signed.info;
  }

  private async nodeInfo(): Promise<NodeInfo> {
    return this.info ?? this.fetchInfo();
  }

  /** The key this client uses on this node (identity or pseudonym modes). */
  async key(): Promise<Identity> {
    if (this.options.auth === 'identity') return this.options.identity;
    const info = await this.nodeInfo();
    return derivePseudonym(this.options.identity.seed, info.id);
  }

  async accountId(): Promise<string | undefined> {
    if (this.options.auth === 'anonymous') return this.options.account?.anonymousToken ? this.options.account.accountId : undefined;
    return (await this.key()).id;
  }

  private async openSession(): Promise<string> {
    const info = await this.nodeInfo();
    const ts = Date.now();
    if (this.options.auth === 'anonymous') {
      const stored = this.options.account?.anonymousToken;
      if (stored) return stored;
      const nonce = randomHex(12);
      const pow = solveProofOfWork(powInput(info.id, `anon:${nonce}`, ts), info.signup.powBits);
      const response = await this.post<SessionResponse>('/v1/auth/anonymous', { ts, nonce, pow });
      const account = { anonymousToken: response.token, accountId: response.accountId };
      this.options.account = account;
      this.options.onAccount?.(account);
      return response.token;
    }
    const key = await this.key();
    const body = { key: key.id, ts, sig: signData(key, sessionSigningPayload(info.id, ts)) };
    let response: SessionResponse;
    try {
      response = await this.post<SessionResponse>('/v1/auth/session', body);
    } catch (error) {
      if (!(error instanceof RemoteError) || error.code !== 'pow_required') throw error;
      const retryTs = Date.now();
      const pow = solveProofOfWork(powInput(info.id, key.id, retryTs), info.signup.powBits);
      response = await this.post<SessionResponse>('/v1/auth/session', {
        key: key.id,
        ts: retryTs,
        sig: signData(key, sessionSigningPayload(info.id, retryTs)),
        pow,
      });
    }
    const expires = response.expiresAt ? Date.parse(response.expiresAt) - 60_000 : Date.now() + 3600_000;
    this.session = { token: response.token, expires };
    return response.token;
  }

  async token(): Promise<string> {
    if (this.options.auth !== 'anonymous' && this.session && this.session.expires > Date.now()) return this.session.token;
    if (this.options.auth === 'anonymous' && this.options.account?.anonymousToken) return this.options.account.anonymousToken;
    this.pending ??= this.openSession().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private forgetSession(): void {
    this.session = null;
    if (this.options.auth === 'anonymous' && this.options.account) {
      this.options.account = {};
      this.options.onAccount?.({});
    }
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request(`${this.url}${path}`, { body, timeoutMs: this.options.timeoutMs ?? 15000 }).then(
      (response) => response.json() as Promise<T>
    );
  }

  /** A request with the account token; re-authenticates once if the node forgot the session. */
  async fetch(path: string, options: RequestOptions & { auth?: boolean } = {}): Promise<Response> {
    const send = async () => {
      const headers = { ...options.headers };
      if (options.auth !== false) headers.authorization = `Bearer ${await this.token()}`;
      return this.request(`${this.url}${path}`, { timeoutMs: this.options.timeoutMs ?? 15000, ...options, headers });
    };
    return this.observed(async () => {
      try {
        return await send();
      } catch (error) {
        if (error instanceof RemoteError && error.status === 401 && options.auth !== false) {
          this.forgetSession();
          return send();
        }
        throw error;
      }
    });
  }

  async json<T>(path: string, options: RequestOptions & { auth?: boolean } = {}): Promise<T> {
    const response = await this.fetch(path, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
