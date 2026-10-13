import { defineConfig } from '@playwright/test';

/**
 * Two servers, because the app has two ways to reach its data.
 *
 * The **demo** server sets `VITE_STATIC_DEMO`, so the bundle uses the in-memory demo API and never
 * touches the network. That is what most specs want: deterministic data, no service to run.
 *
 * The **live** server leaves it unset, so the bundle uses the real HTTP client. That is the only way
 * to exercise anything about the *transport* — an outage, a rejected poll, a recovery, or the state
 * the app starts in when no service is running at all, which is the first screen of every launch.
 *
 * It matters because the demo server was the only one for a long time, and every request-based claim
 * in the suite was therefore untested. `service-outage.spec.ts` intercepted the API and aborted it to
 * kill the service; the app never made the request. Measured with the demo server: **0** API
 * requests (the only URLs containing `/api/` were Vite serving `src/api/*.ts` modules).
 */
const demoURL = 'http://127.0.0.1:4174';
const liveURL = 'http://127.0.0.1:4175';

/** Specs that need the real client, and so run on the live server. */
const liveSpecs = /(service-outage|no-service)\.spec\.ts$/u;

/** The live server must not inherit the demo switch from the shell that started the run. */
const liveEnv = { ...process.env };
delete liveEnv.VITE_STATIC_DEMO;

export default defineConfig({
  testDir: './test/browser',
  outputDir: './test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  projects: [
    { name: 'demo', testIgnore: liveSpecs, use: { baseURL: demoURL } },
    { name: 'live-api', testMatch: liveSpecs, use: { baseURL: liveURL } },
  ],
  use: {
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4174',
      url: demoURL,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        VITE_STATIC_DEMO: 'true',
      },
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4175',
      url: liveURL,
      reuseExistingServer: !process.env.CI,
      env: liveEnv,
    },
  ],
});