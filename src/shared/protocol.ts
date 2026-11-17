// Wire types of the VibeShare protocol (HTTP + JSON). Browser-safe: no Node imports.
//
// Split by domain under ./protocol/ (info, accounts, storage, content, peers, misc) and
// re-exported here, so every module keeps one import path and the whole wire surface can
// be read in one place.
export * from './protocol/index.js';
