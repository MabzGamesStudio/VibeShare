#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AlgorithmNode, type AlgorithmConfig } from './algorithm/node.js';
import { ClientNode } from './client/daemon.js';
import type { BaseConfig, DeepPartial } from './commerce/node.js';
import { startDemo } from './demo/demo.js';
import { ProviderNode, type ProviderConfig } from './provider/node.js';
import { findGuiDir } from './shared/assets.js';
import { log } from './shared/log.js';
import { SOFTWARE } from './shared/protocol.js';
import { defaultDataDir } from './shared/store.js';

const HELP = `${SOFTWARE} — decentralized file sharing and streaming

Usage: vibeshare <command> [options]

Commands
  client       Run a client node: the app for watching, listening and publishing
               (GUI at http://127.0.0.1:7700)
  provider     Run a content provider node (default port 7701)
  algorithm    Run a search algorithm node (default port 7702)
  demo         Run a provider, an algorithm node and a client together, with sample content
  info         Print the reference and admin token of a provider/algorithm data directory

Options
  --data <dir>         Data directory (default: your OS app data folder)
  --config <file>      Config file for provider/algorithm (default: <data>/config.json)
  --port <n>           Port to listen on
  --host <address>     Address to listen on (client: 127.0.0.1; nodes: 0.0.0.0)
  --public-url <url>   URL clients reach the node at (used in its reference)
  --name <text>        Node name
  --open               Open the GUI in your browser (client, demo)
  --log <level>        debug, info, warn, error or silent
  -h, --help           Show this help
  -v, --version        Show the version

Examples
  vibeshare demo --open
  vibeshare provider --public-url https://cdn.example.org --port 7701
  vibeshare algorithm --data ./curator
  vibeshare client --open
`;

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {};
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') flags.help = true;
    else if (arg === '-v') flags.version = true;
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (!command) command = arg;
  }
  return { command, flags };
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function num(flags: Flags, key: string): number | undefined {
  const value = str(flags, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) fail(`--${key} must be a port number`);
  return parsed;
}

function fail(message: string): never {
  console.error(`vibeshare: ${message}`);
  process.exit(1);
}

export function openInBrowser(url: string): void {
  // rundll32 avoids cmd.exe, which would split the URL at "&".
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // no browser available: the URL is printed anyway
  }
}

function onShutdown(stop: () => Promise<void>): void {
  let stopping = false;
  const handler = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nStopping…');
    stop().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

function nodeOverrides(flags: Flags): DeepPartial<BaseConfig> {
  const overrides: DeepPartial<BaseConfig> = {};
  const port = num(flags, 'port');
  if (port !== undefined) overrides.port = port;
  if (str(flags, 'host')) overrides.host = str(flags, 'host');
  if (str(flags, 'public-url')) overrides.publicUrl = str(flags, 'public-url');
  if (str(flags, 'name')) overrides.name = str(flags, 'name');
  return overrides;
}

async function runNode(kind: 'provider' | 'algorithm', flags: Flags): Promise<void> {
  const dataDir = resolve(str(flags, 'data') ?? defaultDataDir(kind));
  const configPath = str(flags, 'config') ? resolve(str(flags, 'config')!) : undefined;
  const common = { dataDir, configPath, guiDir: findGuiDir() };
  const node =
    kind === 'provider'
      ? new ProviderNode({ ...common, overrides: nodeOverrides(flags) as DeepPartial<ProviderConfig> })
      : new AlgorithmNode({ ...common, overrides: nodeOverrides(flags) as DeepPartial<AlgorithmConfig> });
  await node.start();
  const tokenFile = join(dataDir, 'admin-token');
  console.log(`
  ${kind === 'provider' ? 'Content provider' : 'Search algorithm'} node "${node.config.name}" is running.

  Reference (share it with clients):
    ${node.reference()}

  Web page:   ${node.url()}/
  Dashboard:  ${node.url()}/admin   (admin token: ${node.adminToken}${existsSync(tokenFile) ? `, stored in ${tokenFile}` : ''})
  Config:     ${configPath ?? join(dataDir, 'config.json')}
`);
  if (!node.config.publicUrl && node.config.host === '0.0.0.0') {
    console.log('  Tip: set --public-url (or publicUrl in the config) to the address clients use, so the reference points there.\n');
  }
  onShutdown(() => node.stop());
}

async function runClient(flags: Flags): Promise<void> {
  const dataDir = resolve(str(flags, 'data') ?? defaultDataDir('client'));
  const client = new ClientNode({
    dataDir,
    port: num(flags, 'port') ?? 7700,
    host: str(flags, 'host') ?? '127.0.0.1',
    guiDir: findGuiDir(),
  });
  await client.start();
  const url = ['127.0.0.1', 'localhost', '::1'].includes(str(flags, 'host') ?? '127.0.0.1') ? client.url() : client.guiUrl();
  console.log(`
  VibeShare client is running: ${url}
  Data: ${dataDir}
  Identity: ${client.store.identity.id}
`);
  if (flags.open) openInBrowser(url);
  onShutdown(() => client.stop());
}

async function runDemo(flags: Flags): Promise<void> {
  const dataDir = resolve(str(flags, 'data') ?? defaultDataDir('demo'));
  const basePort = num(flags, 'port') ?? 7700;
  const demo = await startDemo({ dataDir, basePort, guiDir: findGuiDir() });
  console.log(`
  VibeShare demo network is running.

  Client app:          ${demo.client.url()}
  Provider node:       ${demo.provider.url()}/        dashboard ${demo.provider.url()}/admin
  Algorithm node:      ${demo.algorithm.url()}/        dashboard ${demo.algorithm.url()}/admin
  Admin tokens:        provider ${demo.provider.adminToken}
                       algorithm ${demo.algorithm.adminToken}
  Voucher codes:       ${demo.vouchers.join('  ')}   (500 credits each on the provider)

  References:
    ${demo.provider.reference()}
    ${demo.algorithm.reference()}

  Data: ${dataDir} (delete it to start over)
`);
  if (flags.open) openInBrowser(demo.client.url());
  onShutdown(() => demo.stop());
}

function info(flags: Flags): void {
  const dataDir = resolve(str(flags, 'data') ?? fail('--data <dir> is required'));
  const identity = join(dataDir, 'identity.json');
  if (!existsSync(identity)) fail(`${dataDir} is not a node data directory`);
  const config = existsSync(join(dataDir, 'config.json')) ? JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) : {};
  const { id } = JSON.parse(readFileSync(identity, 'utf8')) as { id: string };
  const token = existsSync(join(dataDir, 'admin-token')) ? readFileSync(join(dataDir, 'admin-token'), 'utf8').trim() : '(none)';
  const kind = 'pricing' in config && 'storage' in config ? 'provider' : 'algorithm';
  const url = config.publicUrl ?? `http://127.0.0.1:${config.port ?? (kind === 'provider' ? 7701 : 7702)}`;
  console.log(`vs:${kind}:${id}@${url}\nadmin token: ${token}`);
}

async function main(): Promise<void> {
  const { command, flags } = parse(process.argv.slice(2));
  if (typeof flags.log === 'string') log.setLevel(flags.log as 'info');
  if (flags.version) {
    console.log(SOFTWARE);
    return;
  }
  if (flags.help || !command) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'client':
      return runClient(flags);
    case 'provider':
    case 'algorithm':
      return runNode(command, flags);
    case 'demo':
      return runDemo(flags);
    case 'info':
      return info(flags);
    default:
      fail(`unknown command "${command}" (see vibeshare --help)`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
