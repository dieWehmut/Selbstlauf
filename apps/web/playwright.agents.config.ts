import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/agents', workers: 1, timeout: 30000,
  outputDir: './test-results/agents', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:49381', trace: 'retain-on-failure' },
  webServer: {
    command: 'node ../../scripts/verify/agent-windows-host.mjs',
    url: 'http://127.0.0.1:49381/api/health', reuseExistingServer: false,
  },
});
