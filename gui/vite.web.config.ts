// The static web client: the GUI with normal routes and the client backend running in
// the browser (service worker), built into ../distribution/web for any static host
// (GitHub Pages… — deep links come in through the generated 404.html). Run:
// npm run build:web (in the repository root).
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// `VIBESHARE_WEB_OUT` lets scripts/build-web.ts (or a shell) choose another destination.
// The repository default stays distribution/web for CI and the checked-in publishable site.
const configuredOut = process.env.VIBESHARE_WEB_OUT?.trim();
export const WEB_OUT = configuredOut ? resolve(configuredOut) : resolve(__dirname, '../distribution/web');

/** Swaps the Node implementation of the shared crypto module for the browser one. */
export function webModules(): Plugin {
  // (Vite ids use forward slashes on every OS.)
  const nodeCrypto = normalizePath(resolve(__dirname, '../src/shared/crypto.ts'));
  const webCrypto = normalizePath(resolve(__dirname, 'src/web/crypto.ts'));
  return {
    name: 'vibeshare-web-modules',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !/(^|\/)crypto(\.js|\.ts)?$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && normalizePath(resolved.id) === nodeCrypto ? webCrypto : null;
    },
  };
}

/** config.json (default nodes, share address) and .nojekyll (GitHub Pages) next to the site. */
function siteFiles(): Plugin {
  return {
    name: 'vibeshare-site-files',
    closeBundle() {
      const config = resolve(__dirname, '../distribution/config.json');
      if (existsSync(config)) copyFileSync(config, resolve(WEB_OUT, 'config.json'));
      writeFileSync(resolve(WEB_OUT, '.nojekyll'), '');
      // Deep links (`/watch/<id>`) arrive as unknown paths on a static host, which serves
      // this page: it finds the folder the client is served from, loads that index.html
      // with the folder as its base for every relative URL, and keeps the deep link in
      // the address bar — the app then routes it normally.
      writeFileSync(
        resolve(WEB_OUT, '404.html'),
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>VibeShare</title>
  </head>
  <body>
    <div class="boot">Starting VibeShare…</div>
    <script>
      (function () {
        async function boot(dir) {
          try {
            const answer = await fetch(dir + 'index.html');
            if (!answer.ok) throw new Error(String(answer.status));
            const html = await answer.text();
            document.open();
            document.write(html.replace(/<head[^>]*>/i, (tag) => tag + '<base href="' + dir + '">'));
            document.close();
          } catch (error) {
            location.replace(dir);
          }
        }
        // The client's own folder is the deepest one that holds the service worker.
        (function find(dir) {
          fetch(dir + 'sw.js', { method: 'HEAD' })
            .then((answer) => {
              if (!answer.ok) throw new Error('not here');
              return boot(dir);
            })
            .catch(() => {
              const shorter = dir.replace(/[^/]+\\/$/, '');
              if (shorter === dir) return boot('/');
              find(shorter);
            });
        })(location.pathname.replace(/[^/]*$/, ''));
      })();
    </script>
  </body>
</html>
`
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), webModules(), siteFiles()],
  base: './',
  define: {
    __VIBESHARE_WEB__: 'true',
    __VS_BUILD__: JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'),
  },
  build: {
    outDir: WEB_OUT,
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html') } },
  },
});
