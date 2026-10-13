import { expect, test } from '@playwright/test';

import { createStaticDemoApi } from '../../src/api/static-demo';

/**
 * What the UI does when a service that was answering stops answering.
 *
 * The concern is not that an error appears but that the app stays usable: a rejected poll must not
 * blank the page, wedge the shell, or leave the panels stuck in a permanent loading state.
 *
 * **This spec used to make that claim without making the request.** It ran on the only server there
 * was, which sets `VITE_STATIC_DEMO`, so the bundle used the in-memory demo API; the `page.route`
 * interception below matched nothing and the app never saw an outage. It now runs on the live-API
 * server (see playwright.config.ts), where the bundle uses the real HTTP client, so the requests are
 * real, the abort really is a dead service, and the recovery below really is a recovery.
 *
 * While the service is "up" the requests are answered from the demo API's own data rather than from
 * fixtures written here: `createStaticDemoApi()` is the app's own demo source, so the two cannot
 * drift apart.
 */
test('survives the service going away mid-session', async ({ page }, testInfo) => {
  // This spec waits on real poll cycles (a few seconds apart) across two state changes, so it needs
  // longer than the default per-test budget.
  test.setTimeout(120_000);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const demo = createStaticDemoApi();
  let healthy = true;

  /**
   * The service's own paths, matched by pathname rather than by `**`+`/api/`+`**`: that glob also
   * matches the app's own modules (`/src/api/client.ts`), and answering those with JSON replaces the
   * bundle with a body the browser cannot run — the page then never renders at all.
   */
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    if (!healthy) {
      // A dead service is a connection failure, not an HTTP error body.
      return route.abort('connectionrefused');
    }
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    switch (path) {
      case '/api/health': return respond(await demo.health());
      case '/api/config': return respond(await demo.config());
      case '/api/sessions': return respond(await demo.sessions());
      case '/api/startup': return respond(await demo.startup());
      case '/api/claude-hook': return respond(await demo.claudeHook());
      case '/api/codex/profiles': return respond(await demo.codexProfiles());
      case '/api/environment': return respond(await demo.environment());
      case '/api/events':
        // The app subscribes with EventSource; an empty stream is enough for it to stay quiet.
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': demo\n\n' });
      default: return route.fulfill({ status: 204, body: '' });
    }
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
  // With the service answering, its sessions are on screen — which is what makes the outage below
  // a change of state rather than the app's default.
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible();

  // The service dies.
  healthy = false;

  /**
   * Wait for the outage to be *observed*, not for a fixed number of seconds.
   *
   * The next poll has to fail before anything changes on screen, and a loaded machine can take
   * longer than one poll interval to get there — a fixed six-second sleep passed here and timed out
   * elsewhere on the same tree.
   */
  const sectionMeta = page.locator('.content-section').first().locator('.section-meta');
  await expect
    .poll(async () => (await sectionMeta.textContent()) ?? '', { timeout: 30_000 })
    .toContain('等待连接');

  // The shell must still be there: an unhandled rejection would take it down.
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.titlebar')).toBeVisible();
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  // Navigate anyway; every page must still render with the service gone.
  await page.locator('.sidebar').getByRole('button', { name: '事件' }).click();
  await expect(page.getByRole('heading', { name: '事件记录' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('service-down.png'), fullPage: true });

  // The service comes back; the app must recover without a reload. 设置 hides the app
  // sidebar, so leaving it goes through 返回应用.
  healthy = true;
  await page.getByRole('button', { name: /返回应用/u }).click();
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
  await expect(page.locator('.app-shell')).toBeVisible();
  // Recovering means the reconnect is real: the section reports live data again and the sessions
  // are back — not merely that the shell survived.
  await expect
    .poll(async () => (await sectionMeta.textContent()) ?? '', { timeout: 30_000 })
    .toContain('实时同步');
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  expect(pageErrors, `page errors during the outage: ${pageErrors.join(' | ')}`).toEqual([]);
});