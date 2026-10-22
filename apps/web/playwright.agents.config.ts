import { defineConfig } from '@playwright/test';

const environment = { ...process.env };
delete environment.VITE_STATIC_DEMO;

export default defineConfig({
  testDir: './test/agents', workers: 1, timeout: 30000,
  outputDir: './test-results/agents', reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'service', use: { baseURL: 'http://127.0.0.1:49381' } },
    { name: 'dev-proxy', use: { baseURL: 'http://127.0.0.1:49383' } },
  ],
  webServer: [{
    command: 'node ../../scripts/verify/agent-windows-host.mjs',
    url: 'http://127.0.0.1:49381/api/health', reuseExistingServer: false, env: environment,
  }, {
    command: 'npm run dev -- --host 127.0.0.1 --port 49383', url: 'http://127.0.0.1:49383', reuseExistingServer: false,
    env: { ...environment, WATCHDOG_PROXY_TARGET: 'http://127.0.0.1:49381' },
  }],
});
