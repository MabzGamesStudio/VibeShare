// The web client's service worker, as one classic script (every browser runs those).
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { WEB_OUT, webModules } from './vite.web.config';

export default defineConfig({
  plugins: [webModules()],
  define: { __VIBESHARE_WEB__: 'true', 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: WEB_OUT,
    emptyOutDir: false,
    lib: { entry: resolve(__dirname, 'src/web/sw.ts'), formats: ['iife'], name: 'VibeShareWorker', fileName: () => 'sw.js' },
  },
});
