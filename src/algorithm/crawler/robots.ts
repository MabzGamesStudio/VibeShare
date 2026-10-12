// robots.txt (RFC 9309). The crawler checks every URL against the site's rules before
// requesting it, for its own product token or, when no group names it, the `*` group.

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay?: number;
}

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/** Percent-encodes what a URL path would encode, so patterns and paths compare alike. */
function normalizePattern(pattern: string): string {
  try {
    return encodeURI(decodeURI(pattern));
  } catch {
    return pattern;
  }
}

export class Robots {
  constructor(
    private readonly groups: Group[],
    readonly sitemaps: string[] = []
  ) {}

  static allowAll(): Robots {
    return new Robots([]);
  }

  static disallowAll(): Robots {
    return new Robots([{ agents: ['*'], rules: [{ allow: false, pattern: '/', regex: compile('/') }] }]);
  }

  static parse(text: string): Robots {
    const groups: Group[] = [];
    const sitemaps: string[] = [];
    let current: Group | null = null;
    let lastWasAgent = false;
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'user-agent') {
        if (!current || !lastWasAgent) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      if (key === 'sitemap') {
        if (value) sitemaps.push(value);
        continue;
      }
      lastWasAgent = false;
      if (!current) continue; // rules before any user-agent line belong to no group
      if (key === 'allow' || key === 'disallow') {
        if (!value) continue; // "Disallow:" with nothing allows everything
        const pattern = normalizePattern(value);
        current.rules.push({ allow: key === 'allow', pattern, regex: compile(pattern) });
      } else if (key === 'crawl-delay') {
        const delay = Number(value);
        if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
      }
    }
    return new Robots(groups, sitemaps);
  }

  /** The rules for a product token: every group naming it, else every `*` group, combined. */
  private rulesFor(token: string): { rules: Rule[]; crawlDelay?: number } {
    const name = token.toLowerCase();
    let matching = this.groups.filter((group) => group.agents.includes(name));
    if (!matching.length) matching = this.groups.filter((group) => group.agents.includes('*'));
    const delays = matching.map((group) => group.crawlDelay).filter((delay): delay is number => delay !== undefined);
    return { rules: matching.flatMap((group) => group.rules), crawlDelay: delays.length ? Math.max(...delays) : undefined };
  }

  /** Whether `token` may fetch `pathAndQuery` (e.g. "/watch?v=1"). The most specific rule wins; Allow wins ties. */
  isAllowed(token: string, pathAndQuery: string): boolean {
    const path = pathAndQuery || '/';
    if (path === '/robots.txt') return true;
    let best: Rule | null = null;
    for (const rule of this.rulesFor(token).rules) {
      if (!rule.regex.test(path)) continue;
      if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)) {
        best = rule;
      }
    }
    return best ? best.allow : true;
  }

  crawlDelaySeconds(token: string): number | undefined {
    return this.rulesFor(token).crawlDelay;
  }
}
