// @vibeshare/protocol — the VibeShare wire types as one stable import specifier.
//
// The canonical modules stay in src/shared/; this package re-exports them so forks and
// alternative implementations (and tooling) can depend on `@vibeshare/protocol` instead
// of reaching into the repo's paths. See packages/README.md for the layout choice.
export * from '../../src/shared/protocol.js';
