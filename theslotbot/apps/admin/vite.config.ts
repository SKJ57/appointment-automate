/**
 * vite.config.ts
 *
 * Dev server proxy: /api requests are forwarded to the local API server
 * (apps/api, running on :3000 by default) so the browser never deals
 * with CORS during local development — same pattern the production
 * deployment doesn't need, since production serves the built static
 * files from a different origin and relies on the API's CORS config
 * (see apps/api/src/index.ts, ADMIN_PANEL_URL env var) instead.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@theslotbot/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
