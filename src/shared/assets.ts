import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBEDDED_GUI } from './gui-embedded.js';
import type { Ctx } from './http.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** Finds the built web GUI: $VIBESHARE_GUI_DIR, gui/ next to the executable, or gui/dist in the source tree. */
export function findGuiDir(): string | null {
  const candidates: string[] = [];
  if (process.env.VIBESHARE_GUI_DIR) candidates.push(process.env.VIBESHARE_GUI_DIR);
  candidates.push(join(dirname(process.execPath), 'gui'));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, '../../gui/dist'), resolve(here, '../gui'));
  } catch {
    // not a file URL (bundled executable)
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export function hasGui(dir: string | null): boolean {
  return Boolean((dir && existsSync(join(dir, 'index.html'))) || EMBEDDED_GUI?.['index.html']);
}

/**
 * Sends a file of the GUI bundle. Returns false when there is no such file.
 * `transform` can rewrite HTML before it is sent (the client injects its API token).
 */
export function serveStatic(
  ctx: Ctx,
  dir: string | null,
  path: string,
  transform?: (html: string) => string
): boolean {
  const clean = normalize(path).replace(/^([/\\])+/, '');
  if (clean.startsWith('..') || clean.includes(`..${sep}`)) return false;
  const type = TYPES[extname(clean)] ?? 'application/octet-stream';
  const cache = clean.startsWith('assets') ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (dir) {
    const file = join(dir, clean);
    if (existsSync(file) && statSync(file).isFile()) {
      if (transform && clean.endsWith('.html')) {
        const html = transform(readFileSync(file, 'utf8'));
        ctx.res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }).end(html);
      } else {
        ctx.res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'content-length': statSync(file).size });
        if (ctx.req.method === 'HEAD') ctx.res.end();
        else createReadStream(file).pipe(ctx.res);
      }
      return true;
    }
  }
  const embedded = EMBEDDED_GUI?.[clean.split(sep).join('/')];
  if (embedded) {
    let body = Buffer.from(embedded, 'base64');
    if (transform && clean.endsWith('.html')) body = Buffer.from(transform(body.toString('utf8')));
    ctx.res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'content-length': body.length }).end(body);
    return true;
  }
  return false;
}
