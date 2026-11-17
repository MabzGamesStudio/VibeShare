// Deprecation and Sunset headers — the machine-readable way a route or field says
// "still here, going away" (RFC 9745 and RFC 8594). Kept in its own module instead of
// the HTTP layer because that one is shared with unrelated work: a server sets these
// on any response of a deprecated surface, and a client reads them to warn before the
// surface disappears. The policy behind them is in docs/PROTOCOL.md.

export interface DeprecationOptions {
  /** When the route or field was deprecated (defaults to now). */
  deprecatedAt?: Date | string;
  /** When it is expected to stop working — the RFC 8594 Sunset header. */
  sunset?: Date | string;
  /** Where the story is written (docs, changelog) — sent as rel="deprecation". */
  link?: string;
}

function unixSeconds(at: Date | string | number): string {
  return `@${Math.floor(new Date(at).getTime() / 1000)}`;
}

function httpDate(at: Date | string | number): string {
  return new Date(at).toUTCString();
}

/** The headers a response carries while something deprecated is still served. */
export function deprecationHeaders(options: DeprecationOptions = {}): Record<string, string> {
  const headers: Record<string, string> = { Deprecation: unixSeconds(options.deprecatedAt ?? Date.now()) };
  if (options.sunset) headers.Sunset = httpDate(options.sunset);
  if (options.link) headers.Link = `<${options.link}>; rel="deprecation"`;
  return headers;
}

/** What a response's deprecation headers say (null when nothing is deprecated). */
export function deprecationOf(headers: Record<string, string | undefined>): { deprecatedAt: string; sunset?: string; link?: string } | null {
  const deprecation = headers.Deprecation ?? headers.deprecation;
  if (!deprecation) return null;
  const link = /<([^>]+)>/.exec(headers.Link ?? headers.link ?? '')?.[1];
  return { deprecatedAt: deprecation, sunset: headers.Sunset ?? headers.sunset, link };
}
