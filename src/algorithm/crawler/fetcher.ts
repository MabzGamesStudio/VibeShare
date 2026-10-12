import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { log } from '../../shared/log.js';
import { Robots } from './robots.js';

export class RobotsDisallowed extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
  }
}

export class FetchFailed extends Error {
  constructor(
    message: string,
    readonly status = 0,
    /** Seconds the server asked to wait (Retry-After), on 429 answers. */
    readonly retryAfter?: number
  ) {
    super(message);
  }
}

/** The operator blocked this site (or it is outside the sites they allow). */
export class SiteBlocked extends Error {
  constructor(readonly host: string) {
    super(`${host} is blocked on this node`);
  }
}

export interface ApiRequest {
  method?: string;
  headers?: Record<string, string>;
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  maxBytes?: number;
}

export interface FetcherOptions {
  /** Full User-Agent header, e.g. "VibeShareBot/0.1 (+https://…)". */
  userAgent: string;
  /** Delay between two requests to the same host when robots.txt sets none. */
  defaultDelayMs: () => number;
  timeoutMs: () => number;
  /** Allow crawling addresses on private networks (tests, intranets). */
  allowPrivate: () => boolean;
  /** Ceiling for robots.txt Crawl-delay, so one site cannot stall the crawler forever. */
  maxDelayMs?: number;
  /** Sites the operator blocked: nothing is fetched from them. */
  blocked?: (host: string) => boolean;
  /** Spacing of official API calls to one host (their own rate limits apply too). */
  apiDelayMs?: () => number;
}

export interface Fetched {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  text(): string;
  json<T>(): T;
}

export interface HostStats {
  requests: number;
  blocked: number;
  errors: number;
  lastError?: string;
}

const ROBOTS_TTL_MS = 24 * 3600_000;
const ROBOTS_ERROR_TTL_MS = 3600_000;

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
}

/**
 * HTTP for the crawler, polite by construction: robots.txt is honoured for every URL
 * (and every redirect hop), each host gets at most one request per delay, bodies and
 * waiting times are bounded, and internal addresses are refused.
 */
export class PoliteFetcher {
  readonly token: string;
  private robots = new Map<string, { robots: Robots; expires: number }>();
  private robotsLoading = new Map<string, Promise<Robots>>();
  private nextSlot = new Map<string, number>();
  private dns = new Map<string, { ok: boolean; expires: number }>();
  readonly hosts = new Map<string, HostStats>();

  constructor(private readonly options: FetcherOptions) {
    this.token = options.userAgent.split('/')[0].trim();
  }

  private stats(host: string): HostStats {
    let stats = this.hosts.get(host);
    if (!stats) {
      stats = { requests: 0, blocked: 0, errors: 0 };
      this.hosts.set(host, stats);
      if (this.hosts.size > 2000) this.hosts.delete(this.hosts.keys().next().value!);
    }
    return stats;
  }

  private async checkAddress(url: URL): Promise<void> {
    if (this.options.blocked?.(url.hostname.toLowerCase())) throw new SiteBlocked(url.hostname);
    if (this.options.allowPrivate()) return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      if (isPrivateAddress(host)) throw new FetchFailed(`Refusing to crawl a private address (${host})`);
      return;
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new FetchFailed(`Refusing to crawl ${host}`);
    }
    const cached = this.dns.get(host);
    if (cached && cached.expires > Date.now()) {
      if (!cached.ok) throw new FetchFailed(`${host} resolves to a private address`);
      return;
    }
    let ok = true;
    try {
      const addresses = await lookup(host, { all: true });
      ok = addresses.length > 0 && !addresses.some((entry) => isPrivateAddress(entry.address));
    } catch {
      ok = true; // unresolvable: the fetch itself will fail
    }
    this.dns.set(host, { ok, expires: Date.now() + 300_000 });
    if (!ok) throw new FetchFailed(`${host} resolves to a private address`);
  }

  /** Waits for this host's next free slot (one request per delay). */
  private async slot(origin: string, delayMs: number): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlot.get(origin) ?? 0);
    this.nextSlot.set(origin, at + delayMs);
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now).unref?.());
  }

  private delayFor(origin: string): number {
    const robots = this.robots.get(origin)?.robots;
    const crawlDelay = robots?.crawlDelaySeconds(this.token);
    const max = this.options.maxDelayMs ?? 60_000;
    return Math.min(max, Math.max(this.options.defaultDelayMs(), crawlDelay !== undefined ? crawlDelay * 1000 : 0));
  }

  /**
   * robots.txt of an origin: 2xx is parsed; 4xx means everything is allowed; 5xx or an
   * unreachable site means nothing is (for an hour), as RFC 9309 asks.
   */
  async robotsFor(origin: string): Promise<Robots> {
    const cached = this.robots.get(origin);
    if (cached && cached.expires > Date.now()) return cached.robots;
    const loading = this.robotsLoading.get(origin);
    if (loading) return loading;
    const promise = (async () => {
      let robots: Robots;
      let ttl = ROBOTS_TTL_MS;
      try {
        await this.slot(origin, this.options.defaultDelayMs());
        const response = await this.raw(new URL('/robots.txt', origin), 5);
        if (response.status >= 200 && response.status < 300) robots = Robots.parse(response.body.toString('utf8').slice(0, 500_000));
        else if (response.status >= 400 && response.status < 500) robots = Robots.allowAll();
        else {
          robots = Robots.disallowAll();
          ttl = ROBOTS_ERROR_TTL_MS;
        }
      } catch (error) {
        log.debug(`robots.txt of ${origin}: ${(error as Error).message}`);
        robots = Robots.disallowAll();
        ttl = ROBOTS_ERROR_TTL_MS;
      }
      this.robots.set(origin, { robots, expires: Date.now() + ttl });
      if (this.robots.size > 5000) this.robots.delete(this.robots.keys().next().value!);
      return robots;
    })().finally(() => this.robotsLoading.delete(origin));
    this.robotsLoading.set(origin, promise);
    return promise;
  }

  async allowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const robots = await this.robotsFor(parsed.origin);
    return robots.isAllowed(this.token, parsed.pathname + parsed.search);
  }

  /** A single request, without following redirects. */
  private async once(url: URL, accept: string, maxBytes: number): Promise<{ location?: URL; fetched?: Fetched }> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchFailed(`Unsupported URL ${url}`);
    await this.checkAddress(url);
    const response = await fetch(url, {
      headers: { 'user-agent': this.options.userAgent, accept },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.options.timeoutMs()),
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      return { location: new URL(location, url) };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) throw new FetchFailed(`Response larger than ${maxBytes} bytes`);
        chunks.push(Buffer.from(chunk));
      }
    }
    const body = Buffer.concat(chunks);
    return {
      fetched: {
        url: url.toString(),
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body,
        text: () => body.toString('utf8'),
        json: <T>() => JSON.parse(body.toString('utf8')) as T,
      },
    };
  }

  /** Follows redirects without robots checks (robots.txt itself). */
  private async raw(url: URL, maxRedirects: number): Promise<Fetched> {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const result = await this.once(current, 'text/plain,*/*', 500_000);
      if (result.fetched) return result.fetched;
      current = result.location!;
    }
    throw new FetchFailed('Too many redirects');
  }

  /**
   * GET a URL the polite way. Throws RobotsDisallowed when robots.txt forbids it (for
   * the URL or any redirect target) and FetchFailed for non-2xx answers.
   */
  async get(url: string, options: { accept?: string; maxBytes?: number } = {}): Promise<Fetched> {
    let current = new URL(url);
    for (let hop = 0; hop <= 5; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new FetchFailed(`Unsupported URL ${current}`);
      await this.checkAddress(current);
      const stats = this.stats(current.host);
      const robots = await this.robotsFor(current.origin);
      if (!robots.isAllowed(this.token, current.pathname + current.search)) {
        stats.blocked++;
        throw new RobotsDisallowed(current.toString());
      }
      await this.slot(current.origin, this.delayFor(current.origin));
      stats.requests++;
      let result: { location?: URL; fetched?: Fetched };
      try {
        result = await this.once(current, options.accept ?? '*/*', options.maxBytes ?? 2_000_000);
      } catch (error) {
        stats.errors++;
        stats.lastError = (error as Error).message;
        throw error;
      }
      if (result.location) {
        current = result.location;
        continue;
      }
      const response = result.fetched!;
      if (response.status < 200 || response.status >= 300) {
        stats.errors++;
        stats.lastError = `HTTP ${response.status}`;
        throw new FetchFailed(`${current.host} answered ${response.status}`, response.status);
      }
      return response;
    }
    throw new FetchFailed('Too many redirects');
  }

  /**
   * A call to a platform's official API with the operator's credentials. These follow
   * the API's terms and rate limits (the crawler counts them against a daily budget),
   * not robots.txt, which is about crawling pages; addresses are checked and calls to
   * one host are spaced all the same.
   */
  async api(url: string, request: ApiRequest = {}): Promise<Fetched> {
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new FetchFailed(`Unsupported URL ${target}`);
    await this.checkAddress(target);
    const stats = this.stats(target.host);
    await this.slot(target.origin, this.options.apiDelayMs?.() ?? 250);
    stats.requests++;
    const headers: Record<string, string> = { 'user-agent': this.options.userAgent, accept: 'application/json', ...request.headers };
    let body: string | undefined;
    if (request.form) {
      body = new URLSearchParams(request.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (request.json !== undefined) {
      body = JSON.stringify(request.json);
      headers['content-type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method ?? (body !== undefined ? 'POST' : 'GET'),
        headers,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.options.timeoutMs()),
      });
    } catch (error) {
      stats.errors++;
      stats.lastError = (error as Error).message;
      throw new FetchFailed(`${target.host}: ${(error as Error).message}`);
    }
    const max = request.maxBytes ?? 5_000_000;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > max) throw new FetchFailed(`Response larger than ${max} bytes`);
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    if (!response.ok) {
      stats.errors++;
      stats.lastError = `HTTP ${response.status}`;
      const retry = Number(response.headers.get('retry-after'));
      const detail = data.toString('utf8').replace(/\s+/g, ' ').slice(0, 160);
      throw new FetchFailed(`${target.host} answered ${response.status}${detail ? `: ${detail}` : ''}`, response.status, Number.isFinite(retry) ? retry : undefined);
    }
    return {
      url: response.url || target.toString(),
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body: data,
      text: () => data.toString('utf8'),
      json: <T>() => JSON.parse(data.toString('utf8')) as T,
    };
  }

  robotsCount(): number {
    return this.robots.size;
  }
}
