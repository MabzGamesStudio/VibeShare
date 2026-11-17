// The project version, in one place.
//
// `package.json` is the source of truth: tests/version.test.ts fails when this constant
// and package.json disagree, so a release bump cannot leave the wire's self-description
// (`SOFTWARE` in protocol.ts) stale. Kept as a plain constant because the wire modules
// are browser-safe and cannot read the filesystem.
export const VERSION = '0.1.0';
