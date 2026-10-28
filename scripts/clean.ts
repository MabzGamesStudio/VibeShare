// Removes generated build outputs, keeping source and checked-in publishing files.
// `distribution/` is intentionally preserved: it holds config.json and the committed
// web client site checked by CI. Run: npm run clean
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const generated = ['dist', 'gui/dist', 'desktop/core', 'desktop/gui', 'desktop/release', '.vite'];

for (const dir of generated) rmSync(join(root, dir), { recursive: true, force: true });
console.log(`Removed generated build outputs: ${generated.join(', ')}`);
