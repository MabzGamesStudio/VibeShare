// What the wizard keeps between visits: saved hosts, URL jobs, step drafts, and the
// files a host already carries.

import type { HostConfig, UrlJobEntry, HostDraft } from './types';

/** A base URL as a key, so the same address never counts twice. */
export function baseKey(url: string): string {
  return url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------- saved hosts

const HOSTS_KEY = 'vibeshare-earn-hosts';

export function loadHosts(): HostConfig[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(HOSTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as HostConfig[]) : [];
    return Array.isArray(parsed) ? parsed.filter((host) => host && typeof host.baseUrl === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHosts(hosts: HostConfig[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
  } catch {
    // The list still works for this visit when storage is unavailable.
  }
}

export function newHostId(): string {
  return `h-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------- URL jobs

const URL_JOBS_KEY = 'vibeshare-earn-urljobs';

export function loadUrlJobs(): UrlJobEntry[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(URL_JOBS_KEY);
    const parsed = raw ? (JSON.parse(raw) as UrlJobEntry[]) : [];
    return Array.isArray(parsed) ? parsed.filter((job) => job && typeof job.cid === 'string') : [];
  } catch {
    return [];
  }
}

export function saveUrlJobs(jobs: UrlJobEntry[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(URL_JOBS_KEY, JSON.stringify(jobs));
  } catch {
    // The list still works for this visit when storage is unavailable.
  }
}

/** Adds newly uploaded jobs newest-first, keeping one row per content id. */
export function recordUrlJobs(entries: UrlJobEntry[]): UrlJobEntry[] {
  const current = loadUrlJobs();
  const merged = [...entries, ...current.filter((job) => !entries.some((entry) => entry.cid === job.cid))];
  saveUrlJobs(merged);
  return merged;
}

// ---------------------------------------------------------------------- step drafts

const DRAFTS_KEY = 'vibeshare-earn-drafts';

export function loadDrafts(): Record<string, HostDraft> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, HostDraft>) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Saves every step's fields as they are typed — nothing is lost between steps. */
export function saveDrafts(drafts: Record<string, HostDraft>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // The drafts still work for this visit when storage is unavailable.
  }
}

// ---------------------------------------------------------------------- pushing job data

const PUSHED_KEY = 'vibeshare-earn-pushed';

/** What a host already carries: its id → every path inside the site → its digest and size. */
export function loadPushed(hostId: string): Record<string, { hash: string; size: number }> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PUSHED_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, { hash: string; size: number }>>) : {};
    return parsed[hostId] ?? {};
  } catch {
    return {};
  }
}

/** Remembers the files a deployment now carries, so the next one can keep referencing them. */
export function savePushed(hostId: string, files: Record<string, { hash: string; size: number }>): void {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PUSHED_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, { hash: string; size: number }>>) : {};
    parsed[hostId] = files;
    if (typeof localStorage !== 'undefined') localStorage.setItem(PUSHED_KEY, JSON.stringify(parsed));
  } catch {
    // Losing the list only costs a re-upload next time.
  }
}
