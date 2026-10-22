import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4187/Selbstlauf/';

/** Test the artifact Pages uploads, including the repository subpath. */
export default defineConfig({
  testDir: './test/pages',
  outputDir: './test-results/pages',
  workers: 1,
  timeout: 60_000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/pages', open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build --silent && npm run preview -- --host 127.0.0.1 --port 4187 --strictPort --outDir dist-pages',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, VITE_STATIC_DEMO: 'true', VITE_BASE_PATH: '/Selbstlauf/' },
  },
});
