// Host-agnostic share links: a content id as a `vs://` URI. Where the https share link
// names one hosted copy of the web client, this names the content itself — whichever
// app understands the scheme (a web-client copy that claimed it through
// /.well-known/vibeshare, the desktop build, a native app) opens it. The https link
// stays the default everywhere; this is the copy that keeps working when a host goes
// away. Browser-safe.

/** The schemes a VibeShare share URI accepts: the short one and its long form. */
export const SHARE_SCHEMES = ['vs', 'vibeshare'] as const;

/** What a share URI names: the content id, plus the optional provider node hint. */
export interface ShareUri {
  contentId: string;
  /** The provider node id hint (`?p=`), the same hint the https links carry. */
  providerHint?: string;
}

/** `vs://watch/<content-id>` — the content id URL-encoded, so any id survives the trip. */
export function formatShareUri(contentId: string, providerHint?: string): string {
  const hint = providerHint ? `?p=${encodeURIComponent(providerHint)}` : '';
  return `vs://watch/${encodeURIComponent(contentId)}${hint}`;
}

/**
 * Reads a share URI (`vs://…` or `vibeshare://…`). Anything else — an https link, an
 * unknown scheme, a garbled encoding — answers null and the caller falls back to its
 * https link: parsing never throws and never guesses.
 */
export function parseShareUri(text: string): ShareUri | null {
  const match = /^(?:vs|vibeshare):\/\/watch\/([^?#]*[^?#/\s])(?:\/)?(?:\?p=([^#\s]*))?\/?$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  let contentId: string;
  let providerHint: string | undefined;
  try {
    contentId = decodeURIComponent(match[1]);
    providerHint = match[2] ? decodeURIComponent(match[2]) : undefined;
  } catch {
    return null;
  }
  if (!contentId) return null;
  return { contentId, providerHint: providerHint || undefined };
}

/** Whether this text is a share URI this client understands. */
export function isShareUri(text: string): boolean {
  return parseShareUri(text) !== null;
}
