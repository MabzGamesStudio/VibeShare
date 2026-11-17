// One version for the whole local API: the daemon's /api/* routes, the web service
// worker's answers to the same routes, and the GUI that calls them. Browser-safe, so
// every side of the contract imports this single constant and they cannot drift.
//
// Versioning rule: within one API_VERSION every change is additive — new routes, new
// optional fields. Anything breaking (a removed or renamed route, a changed payload
// meaning) bumps API_VERSION, and callers see the bump in the x-vs-api header before
// anything else fails.
export const API_VERSION = 1;

/** Every /api/* reply carries this header so a caller can check compatibility. */
export const API_HEADER = 'x-vs-api';

/** The version marker as headers, for every local-API response. */
export function apiVersionHeaders(): Record<string, string> {
  return { [API_HEADER]: String(API_VERSION) };
}
