import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

// Load BASE_PATH from monorepo root .env (process.env doesn't auto-load .env files)
const env = loadEnv('', path.resolve(__dirname, '../..'), 'BASE_PATH');

// Normalize base path: ensure leading slash, strip trailing slash, then add trailing slash for Vite
const basePath = env.BASE_PATH?.replace(/\/+$/, '').replace(/^\/?/, '/') || '';

export default defineConfig(({ command }) => ({
  // Dev: use full base path for proxy routing + HMR. Production: relative paths (server injects <base> tag)
  base: command === 'serve' && basePath ? `${basePath}/` : './',
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      [`${basePath}/api`]: {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      [`${basePath}/health`]: {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      [`${basePath}/socket.io`]: {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Route pages are lazy-loaded (see App.tsx), so these heavy libs already
        // fall out of the initial bundle; pin them to stable shared chunks so the
        // several chart/map routes share one cached copy loaded on demand.
        // (rolldown requires the function form.)
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          if (/[\\/](highcharts|highcharts-react-official)[\\/]/.test(id)) return 'highcharts';
          if (/[\\/](leaflet|react-leaflet|react-leaflet-heatmap-layer-v3)[\\/]/.test(id)) {
            return 'leaflet';
          }
          if (/[\\/](react|react-dom|react-router)[\\/]/.test(id)) return 'react-vendor';
        },
      },
    },
  },
}));
