// @vibeshare/sources — content ids, source schemes and URL parsing as one stable
// import specifier.
//
// The canonical module stays in src/shared/sources.ts; this package re-exports it so
// forks and alternative implementations can depend on `@vibeshare/sources` instead of
// reaching into the repo's paths. See packages/README.md for the layout choice.
export * from '../../src/shared/sources.js';
