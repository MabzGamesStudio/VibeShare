// Copies the compiled node code (../dist) and the GUI (../gui/dist) into the app.
// Run `npm run build` in the repository root first.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(here);
for (const [from, to] of [
  [join(root, 'dist'), join(here, 'core')],
  [join(root, 'gui', 'dist'), join(here, 'gui')],
]) {
  if (!existsSync(from)) {
    console.error(`${from} is missing: run "npm run build" in the repository root first.`);
    process.exit(1);
  }
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, filter: (path) => !path.endsWith('.map') });
}
console.log('Copied the client and GUI into the desktop app.');
