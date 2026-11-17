// The wire protocol, split by domain. `src/shared/protocol.ts` re-exports this barrel,
// so every module keeps importing `../shared/protocol.js` and the surface stays one file.
export * from './versioning.js';
export * from './info.js';
export * from './accounts.js';
export * from './storage.js';
export * from './content.js';
export * from './peers.js';
export * from './misc.js';
