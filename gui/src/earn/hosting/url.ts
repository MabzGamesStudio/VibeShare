// Base-URL building and parsing: the addresses a platform serves, and how a typed
// address flows back into the fields that build it.

import type { HostingPlatform } from './types';

/** Joins URL path parts with single slashes and a trailing slash. */
export function buildUrl(base: string, ...parts: string[]): string {
  const path = parts.map((part) => part.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  return `https://${base.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/${path}${path ? '/' : ''}`;
}

/** `<base>/<cid>` — the URL providers query for a piece of content. */
export function contentUrl(baseUrl: string, cid: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${cid.trim().replace(/^\/+/, '')}`;
}

/** The file path inside the site (and its git repository) that serves one content id. */
export function contentPath(values: Record<string, string>, cid: string): string {
  const folder = (values.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
  return `${folder ? `${folder}/` : ''}${cid.trim().replace(/^\/+/, '')}`;
}

// --------------------------------------------------------------- base URL parsing

/** A typed base URL split into its lower-cased host and its path parts (no empties). */
export function splitUrl(url: string): { host: string; path: string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return null;
  return { host: parsed.hostname.toLowerCase(), path: parsed.pathname.split('/').filter(Boolean) };
}

/** Base URLs compared as addresses: no scheme, no trailing slash, no case. */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * The shared parser for platforms whose address is https://<value><suffix>/[<folder>/]:
 * the name field is the subdomain and the path is the folder for content ids.
 */
export function hostFolderParser(field: string, suffix: string): (url: string) => Record<string, string> | null {
  return (url) => {
    const split = splitUrl(url);
    if (!split) return null;
    const tail = suffix.toLowerCase();
    if (!split.host.endsWith(tail)) return null;
    const name = split.host.slice(0, -tail.length);
    if (!name || name.endsWith('.')) return null;
    return { [field]: name, folder: split.path.join('/') };
  };
}

/** The fallback for platforms without their own parser: map back only the folder part. */
function genericParseBaseUrl(platform: HostingPlatform, url: string, values: Record<string, string>): Record<string, string> | null {
  const split = splitUrl(url);
  if (!split) return null;
  // Where the address stops being the host and starts being the folder is unknown here:
  // try every split and keep the first one that rebuilds exactly this address.
  for (let keep = 0; keep <= split.path.length; keep++) {
    const folder = split.path.slice(keep).join('/');
    if (normalizeUrl(platform.buildBaseUrl({ ...values, folder })) === normalizeUrl(url)) return { folder };
  }
  return null;
}

/**
 * Parses a typed base URL back into the fields: the platform's own parser, or the
 * generic host-and-folder one when it has none. `null` = the structure does not match.
 */
export function parseHostUrl(platform: HostingPlatform, url: string, values: Record<string, string>): Record<string, string> | null {
  return (platform.parseBaseUrl ?? ((target) => genericParseBaseUrl(platform, target, values)))(url, values);
}

/**
 * The content id of the default article describing VibeShare. It is hard coded into the
 * client so a job is never blocked on finding one: when no jobs are found on a provider
 * node, or a plain content id is needed to try a base URL with, always use this one.
 */
export const DUMMY_CID = 'vs1fvghgh33iz7bzlpv6manelcghldqf3fwjh7l57wnm3nj7br6aayq';
