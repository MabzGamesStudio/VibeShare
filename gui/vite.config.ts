import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client daemon serves the built GUI. During development, run the daemon
// (`npm run client` in the repository root) and `npm run dev` here, then open the
// URL the daemon prints with ?t=… but on port 5173.
const daemon = process.env.VIBESHARE_DAEMON ?? 'http://127.0.0.1:7700';

export default defineConfig({
  plugins: [react()],
  base: '/',
  define: { __VIBESHARE_WEB__: 'false' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), admin: resolve(__dirname, 'admin.html') },
    },
  },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/api': daemon,
      '/stream': daemon,
    },
  },
});
