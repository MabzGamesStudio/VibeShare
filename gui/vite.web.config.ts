// The static web client: the GUI with a hash router and the client backend running in
// the browser (service worker), built into ../distribution/web for any static host
// (GitHub Pages…). Run: npm run build:web (in the repository root).
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

export const WEB_OUT = resolve(__dirname, '../distribution/web');

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
