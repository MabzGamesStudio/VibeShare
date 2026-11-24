// Cookie and third-party embed consent — the strictest reading of the GDPR and the
// ePrivacy Directive:
//   * nothing non-essential (no embedded player, no platform preview) loads before an
//     explicit choice: browsing or scrolling is never consent;
//   * rejecting is exactly as easy as accepting — two equal buttons, nothing pre-chosen;
//   * the choice is stated in plain language, third-party tracking cookies named;
//   * the choice is as easy to withdraw as it was to give (Settings, or the banner again);
//   * the consent record itself is the only thing stored, and it is strictly necessary
//     (it is how the choice is remembered) — it goes nowhere, stays on this device;
//   * a Do Not Track or Global Privacy Control signal is honored by keeping embeds off
//     until the person says otherwise;
//   * when the purposes change (this version number), everyone is asked again.
//
// The choice can be made per platform as well as whole: `choice` is the default for
// every platform, and `platforms` narrows (or widens) it one platform at a time. The
// purposes did not change with that finer control — the same embeds and cookies are
// being decided about — so the version stays 1 and a record saved before it (one global
// choice, no map) keeps meaning exactly what it meant: its choice decides everything.

import { parseContentId, sourceSchemeLabel, sourceSchemes } from '../../src/shared/sources.js';

export type EmbedConsent = 'accepted' | 'rejected';

export interface ConsentRecord {
  choice: EmbedConsent;
  /**
   * Per-platform decisions (source scheme id → allowed). An entry overrides the
   * global choice for that platform; platforms without one follow the choice.
   */
  platforms?: Record<string, boolean>;
  /** When the choice was made (ISO). */
  at: string;
  /** The policy version the choice was made under — a change re-asks. */
  version: number;
}

/** Bump when the purposes described to the user change: everyone is asked again. */
export const CONSENT_VERSION = 1;

const KEY = 'vs-embed-consent';

/** A Do Not Track or Global Privacy Control request, when the browser makes one. */
export function doNotTrack(): boolean {
  if (typeof navigator === 'undefined') return false;
  const gpc = (globalThis as { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  const dnt =
    (navigator as Navigator & { doNotTrack?: string }).doNotTrack === '1' || (navigator as { msDoNotTrack?: string }).msDoNotTrack === '1';
  return gpc || dnt;
}

/** The consent platform of a content id: the scheme its first source speaks. */
export function platformKeyOf(id: string | undefined): string {
  const parsed = parseContentId(id ?? '');
  if (!parsed || parsed.native) return 'vibeshare';
  return String(parsed.sources[0]?.scheme ?? 'url');
}

/** Every platform the user can decide about, in display order, with its label. */
export function platformChoices(): { id: string; label: string }[] {
  return sourceSchemes().map((scheme) => ({ id: scheme.id, label: scheme.label || sourceSchemeLabel(scheme.id) || scheme.id }));
}

/**
 * The pure policy: may third-party content load? No record (or one from an older
 * policy) means no — nothing loads before an explicit accept. With a platform named,
 * that platform's own decision wins when there is one and the global choice decides
 * the rest; without one, the answer is whether anything at all may load. An explicit
 * accept is the one thing that turns embeds on, whatever hints the browser sends; a
 * rejection, or a Do Not Track / Global Privacy Control signal with no choice, keeps
 * them off.
 */
export function embedsAllowed(record: ConsentRecord | null, platform?: string): boolean {
  if (!record || record.version !== CONSENT_VERSION) return false;
  if (platform) {
    const own = record.platforms?.[platform];
    // The platform's own answer wins; everything the map does not name follows the
    // global choice alone (a platform switched on one by one never switches on others).
    return own !== undefined ? own : record.choice === 'accepted';
  }
  if (record.choice === 'accepted') return true;
  // Nothing decided globally: a platform the person switched on one by one still loads.
  return Object.values(record.platforms ?? {}).some((allowed) => allowed);
}

/** The stored consent record, if the person has made one under the current policy. */
export function loadConsent(): ConsentRecord | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as ConsentRecord;
    if (record?.version !== CONSENT_VERSION) return null;
    return record;
  } catch {
    return null;
  }
}

/** Remembers the choice (the consent record — strictly necessary, never sent anywhere). */
export function saveConsent(choice: EmbedConsent): ConsentRecord {
  // A whole-choice answer starts the per-platform map over: "accept" is every platform
  // the person knows about, "reject" is none of them.
  const record: ConsentRecord = { choice, at: new Date().toISOString(), version: CONSENT_VERSION };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Storage refused: the choice still applies for this visit.
  }
  return record;
}

/** Remembers one platform's answer, leaving the global choice and the others as they are. */
export function savePlatform(platform: string, allowed: boolean): ConsentRecord {
  const previous = loadConsent();
  const record: ConsentRecord = {
    choice: previous?.choice ?? 'rejected',
    platforms: { ...(previous?.platforms ?? {}), [platform]: allowed },
    at: new Date().toISOString(),
    version: CONSENT_VERSION,
  };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Storage refused: the choice still applies for this visit.
  }
  return record;
}

/** Remembers a whole set of per-platform answers at once (the banner's list). */
export function savePlatforms(platforms: Record<string, boolean>): ConsentRecord {
  const previous = loadConsent();
  const record: ConsentRecord = {
    choice: previous?.choice ?? 'rejected',
    platforms: { ...platforms },
    at: new Date().toISOString(),
    version: CONSENT_VERSION,
  };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Storage refused: the choice still applies for this visit.
  }
  return record;
}

/** Withdrawal: forget the choice, and the banner asks again. */
export function clearConsent(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Runs after every change of the consent record, so embeds switch at once. */
export function onConsentChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Save and tell everyone listening (the media gate re-applies). */
export function chooseConsent(choice: EmbedConsent): ConsentRecord {
  const record = saveConsent(choice);
  notify();
  return record;
}

/** Save one platform's answer and tell everyone listening. */
export function choosePlatform(platform: string, allowed: boolean): ConsentRecord {
  const record = savePlatform(platform, allowed);
  notify();
  return record;
}

/** Save a whole set of per-platform answers and tell everyone listening. */
export function choosePlatforms(platforms: Record<string, boolean>): ConsentRecord {
  const record = savePlatforms(platforms);
  notify();
  return record;
}

/** Withdraw and tell everyone listening. */
export function withdrawConsent(): void {
  clearConsent();
  notify();
}
