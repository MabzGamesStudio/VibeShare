// Builds the two 32-bit Linux server distributions. Bun has no 32-bit Linux target,
// so these are server-only archives: the compiled app, a matching Node runtime and
// launchers for the provider and algorithm nodes. NodeAV's native codecs are omitted;
// these nodes use FFmpeg first and need it for conversion on 32-bit systems.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ServerDistributionOptions {
  root: string;
  out: string;
  target: 'linux-ia32' | 'linux-armv7l';
  version: string;
}

const RUNTIMES = {
  // Official Node.js publishes armv7l. Linux x86 ended before Node 22; the newest
  // published x86 build is Node 20.19.5 from Node's unofficial-builds archive.
  'linux-ia32': {
    url: 'https://unofficial-builds.nodejs.org/download/release/v20.19.5/node-v20.19.5-linux-x86.tar.xz',
    sha256: 'e005ed7d7039127e947d4dcd0310a081ca6ae8ed2757a6ccc9d4a278415951ca',
  },
  'linux-armv7l': {
    url: 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-armv7l.tar.xz',
    sha256: 'c9057c6a3b8fbb9651ed115c1e96d4a7281b7b9c9ca89fa05865c98ed7ffd437',
  },
} as const;

export async function buildServerDistribution({ root, out, target, version }: ServerDistributionOptions): Promise<string> {
  const runtime = RUNTIMES[target];
  const name = `vibeshare-${version}-${target}`;
  const stage = join(tmpdir(), `vibeshare-server-${target}-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  try {
    // Always compile first: a stale `dist/` must never end up inside a release archive.
    execFileSync('npm', ['run', 'build:node'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

    // The app is plain Node.js output. mediabunny itself is portable JavaScript; the
    // NodeAV native extension is intentionally absent from these 32-bit archives.
    cpSync(join(root, 'dist'), join(stage, 'app', 'dist'), {
      recursive: true,
      filter: (source) => !/(^|\/)\.[^/]+$/.test(source),
    });
    cpSync(join(root, 'node_modules', 'mediabunny'), join(stage, 'app', 'node_modules', 'mediabunny'), { recursive: true });

    const runtimeDir = join(stage, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const tarball = join(tmpdir(), `${name}-node.tar.xz`);
    const response = await fetch(runtime.url);
    if (!response.ok) throw new Error(`Could not download ${runtime.url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== runtime.sha256) throw new Error(`Runtime checksum mismatch for ${runtime.url}`);
    writeFileSync(tarball, bytes);
    execFileSync('tar', ['-xJf', tarball, '-C', runtimeDir, '--strip-components=1'], { stdio: 'inherit' });

    const launcher = (command?: string) =>
      `#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "\${VIBESHARE_NODE:-}" ]; then
  NODE="$VIBESHARE_NODE"
else
  NODE="$HERE/runtime/bin/node"
  if [ ! -x "$NODE" ]; then NODE=node; fi
fi
exec "$NODE" "$HERE/app/dist/cli.js"${command ? ` ${command}` : ''} "$@"
`;
    for (const [file, command] of [
      ['vibeshare', ''],
      ['vibeshare-provider', 'provider'],
      ['vibeshare-algorithm', 'algorithm'],
    ] as const) {
      writeFileSync(join(stage, file), launcher(command));
      chmodSync(join(stage, file), 0o755);
    }
    writeFileSync(
      join(stage, 'README.md'),
      `# VibeShare ${version} — ${target} server distribution

This archive contains the VibeShare provider and search-algorithm nodes for 32-bit Linux.
Run:

    ./vibeshare-provider --public-url https://cdn.example.org
    ./vibeshare-algorithm --public-url https://feed.example.org

The generic \`vibeshare\` launcher accepts the same commands and options as the normal CLI.
The bundled Node.js runtime is ${target === 'linux-ia32' ? 'Node.js 20.19.5 (the newest published Linux x86 runtime)' : 'Node.js 22.23.4'}.
Set \`VIBESHARE_NODE\` to use another Node runtime instead.

NodeAV's native codec packages do not support 32-bit Linux and are not included. Provider
VVSH conversion uses FFmpeg first; install FFmpeg with libvpx-vp9 and libopus (or set
\`VIBESHARE_FFMPEG\`). Without a usable FFmpeg, conversion fails with an explicit message.
`
    );

    mkdirSync(out, { recursive: true });
    const archive = join(out, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', stage, '.'], { stdio: 'inherit' });
    return archive;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
