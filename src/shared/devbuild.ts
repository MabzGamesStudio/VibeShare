/**
 * Developer builds only. Sources run with tsx (the demo and tests), packaged releases
 * run with NODE_ENV=production — endpoints gated on this never reach production. The
 * browser build has no `process` and never counts as a developer build.
 */
export function isDevBuild(): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  return process.env.NODE_ENV !== 'production' && process.env.VIBESHARE_PROD !== '1';
}