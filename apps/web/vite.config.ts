import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createServiceProxy } from './dev-proxy';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    port: 4174,
    strictPort: false,
    proxy: {
      '/api': createServiceProxy(process.env.WATCHDOG_PROXY_TARGET ?? 'http://127.0.0.1:48920'),
    },
  },
});
