import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: './test/setup.ts',
    exclude: ['test/browser/**', 'node_modules/**', 'dist/**'],
    css: true,
  },
});
