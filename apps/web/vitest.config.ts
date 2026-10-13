import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: './test/setup.ts',
    exclude: ['test/browser/**', 'node_modules/**', 'dist/**'],
    css: true,
    /**
     * 20s per test rather than Vitest's 5s default.
     *
     * These tests render the whole application and wait on deferred promises; the slowest — the one that
     * holds an environment scan pending and then exercises several controls — is measured at **4.9s** on
     * this machine even with nothing else running, which is why a loaded machine turned it into a failure
     * three times this session (`Test timed out in 5000ms`, then green when run alone in ~2-5s). A genuine
     * hang still fails: 20s is four times the slowest honest test here.
     */
    testTimeout: 20_000,
  },
});
