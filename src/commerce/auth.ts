import { checkProofOfWork, isKeyId, randomToken, sha256hex, verifySignature } from '../shared/crypto.js';
import { badRequest, forbidden, HttpError, readJson, unauthorized, type Ctx, type Router } from '../shared/http.js';
import { powInput, sessionSigningPayload, type SessionResponse, type SignupInfo } from '../shared/protocol.js';
import type { Account, Ledger } from './ledger.js';

const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface SignupConfig extends SignupInfo {
  /** New accounts per IP address per hour (0 = unlimited). */
  perIpPerHour: number;
}

/**
 * Two ways to hold an account on a node:
 *  - anonymous: the node hands out a random bearer token; whoever holds it owns the credits.
 *  - key: the client proves it holds an Ed25519 key and gets a session token. The account
 *    (and its credits) follows the key across devices and reinstalls.
 */
export class Auth {
  private sessions = new Map<string, { accountId: string; expires: number }>();
  /** Signatures and proof-of-work inputs already used, to stop replays. */
  private used = new Map<string, number>();
  private signupsByIp = new Map<string, number[]>();

  constructor(
    private readonly ledger: Ledger,
    private readonly nodeId: () => string,
    private readonly signup: () => SignupConfig
  ) {
    setInterval(() => this.prune(), 60_000).unref();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) if (session.expires < now) this.sessions.delete(token);
    for (const [key, expires] of this.used) if (expires < now) this.used.delete(key);
    for (const [ip, times] of this.signupsByIp) {
      const recent = times.filter((time) => now - time < 3600_000);
      if (recent.length) this.signupsByIp.set(ip, recent);
      else this.signupsByIp.delete(ip);
    }
  }

  private checkFresh(ts: unknown): number {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) throw badRequest('ts (milliseconds) is required');
    if (Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) throw badRequest('ts is too far from the node clock');
    return ts;
  }

  private once(key: string): void {
    if (this.used.has(key)) throw forbidden('This proof was already used');
    this.used.set(key, Date.now() + 2 * MAX_CLOCK_SKEW_MS);
  }

  private checkSignupAllowed(ip: string, subject: string, ts: number, pow: unknown): void {
    const config = this.signup();
    if (!checkProofOfWork(powInput(this.nodeId(), subject, ts), String(pow ?? ''), config.powBits)) {
      throw new HttpError(403, 'pow_required', `Opening an account needs ${config.powBits} bits of proof of work`, {
        powBits: config.powBits,
      });
    }
    if (config.perIpPerHour > 0) {
      const now = Date.now();
      const times = (this.signupsByIp.get(ip) ?? []).filter((time) => now - time < 3600_000);
      if (times.length >= config.perIpPerHour) throw new HttpError(429, 'rate_limited', 'Too many new accounts from this address');
      times.push(now);
      this.signupsByIp.set(ip, times);
    }
  }

  async anonymous(ctx: Ctx): Promise<SessionResponse> {
    const config = this.signup();
    if (!config.anonymous) throw forbidden('This node does not offer anonymous accounts; use a key');
    const body = await readJson<{ ts?: number; nonce?: string; pow?: string }>(ctx.req);
    const ts = this.checkFresh(body.ts);
    const nonce = String(body.nonce ?? '');
    if (nonce.length < 8 || nonce.length > 64) throw badRequest('nonce (8–64 characters) is required');
    this.once(`anon:${nonce}`);
    this.checkSignupAllowed(ctx.ip, `anon:${nonce}`, ts, body.pow);
    const token = randomToken(32);
    const account = this.ledger.create('anonymous', { tokenHash: sha256hex(token), grant: config.grant });
    return { token, accountId: account.id, balance: account.balance };
  }

  async session(ctx: Ctx): Promise<SessionResponse> {
    const body = await readJson<{ key?: string; ts?: number; sig?: string; pow?: string }>(ctx.req);
    const key = String(body.key ?? '');
    if (!isKeyId(key)) throw badRequest('key must be a vk1… public key id');
    const ts = this.checkFresh(body.ts);
    const sig = String(body.sig ?? '');
    if (!verifySignature(key, sessionSigningPayload(this.nodeId(), ts), sig)) throw unauthorized('Bad signature');
    this.once(`sig:${sig}`);
    let account = this.ledger.get(key);
    if (!account) {
      this.checkSignupAllowed(ctx.ip, key, ts, body.pow);
      account = this.ledger.create('key', { id: key, grant: this.signup().grant });
    }
    const token = randomToken(32);
    const expires = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { accountId: account.id, expires });
    return { token, accountId: account.id, expiresAt: new Date(expires).toISOString(), balance: account.balance };
  }

  /** The account behind the request's bearer token, if any. */
  account(ctx: Ctx): Account | undefined {
    const header = ctx.req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return undefined;
    const session = this.sessions.get(token);
    let account: Account | undefined;
    if (session && session.expires > Date.now()) account = this.ledger.get(session.accountId);
    else account = this.ledger.byToken(sha256hex(token));
    if (!account) throw unauthorized('Unknown or expired token');
    this.ledger.touch(account);
    return account;
  }

  require(ctx: Ctx): Account {
    const account = this.account(ctx);
    if (!account) throw unauthorized();
    return account;
  }

  routes(router: Router): void {
    router.post('/v1/auth/anonymous', (ctx) => this.anonymous(ctx));
    router.post('/v1/auth/session', (ctx) => this.session(ctx));
  }
}
