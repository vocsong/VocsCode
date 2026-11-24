/** The web dashboard build (code.vocs.io/dashboard, docs/WEB-DASHBOARD.md): plain Vite into the
 *  relay's static assets, base /dashboard/, no Electron or Node in the graph. The electron-vite
 *  config stays for the desktop bundles; this one builds only src/web. */
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve('src/web'),
  base: '/dashboard/',
  plugins: [react()],
  resolve: {
    alias: {
      '@web': resolve('src/web'),
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  build: {
    outDir: resolve('relay/public/dashboard'),
    emptyOutDir: true,
    // Safari 16 is the oldest phone browser the dashboard supports; es2022 keeps the output small.
    target: ['es2022', 'safari16'],
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});
