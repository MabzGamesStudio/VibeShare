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

export type EmbedConsent = 'accepted' | 'rejected';

export interface ConsentRecord {
  choice: EmbedConsent;
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

/**
 * The pure policy: may third-party embeds load? No record (or one from an older policy)
 * means no — nothing loads before an explicit accept. An explicit accept is the one
 * thing that turns embeds on, whatever hints the browser sends; a rejection, or a
 * Do Not Track / Global Privacy Control signal with no choice, keeps them off.
 */
export function embedsAllowed(record: ConsentRecord | null): boolean {
  return Boolean(record && record.version === CONSENT_VERSION && record.choice === 'accepted');
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
  const record: ConsentRecord = { choice, at: new Date().toISOString(), version: CONSENT_VERSION };
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

/** Withdraw and tell everyone listening. */
export function withdrawConsent(): void {
  clearConsent();
  notify();
}