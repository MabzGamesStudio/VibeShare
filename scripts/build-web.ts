// Builds only the static web client. The output folder can be given on the command line
// (which wins) or by VIBESHARE_WEB_OUT; otherwise it is the checked-in distribution/web.
//
//   npm run build:web -- ../../../folder1/folder2/folder3
//   npm run build:web -- --out ../../../folder1/folder2/folder3
//   VIBESHARE_WEB_OUT=/somewhere npm run build:web
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function fail(message: string): never {
  console.error(message);
  console.error('Usage: npm run build:web [-- <output-dir> | --out <output-dir>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let given: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') fail('Builds the static VibeShare web client.');
  if (arg === '--out' || arg === '-o') {
    given = args[++i];
    if (!given) fail(`${arg} needs a folder`);
  } else if (arg.startsWith('--out=')) {
    given = arg.slice('--out='.length);
    if (!given) fail('--out needs a folder');
  } else if (!arg.startsWith('-') && given === undefined) {
    given = arg;
  } else {
    fail(`Unknown argument: ${arg}`);
  }
}

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, given ?? process.env.VIBESHARE_WEB_OUT ?? 'distribution/web');
console.log(`Building the web client into ${out}`);
const result = spawnSync('npm', ['--prefix', 'gui', 'run', 'build:web'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VIBESHARE_WEB_OUT: out },
});
process.exit(result.status ?? 1);
