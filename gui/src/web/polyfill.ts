// The client core is shared with Node and uses Buffer; browsers get a compatible one.
// Import this before anything else.
import { Buffer } from 'buffer';

const scope = globalThis as { Buffer?: unknown };
scope.Buffer ??= Buffer;
