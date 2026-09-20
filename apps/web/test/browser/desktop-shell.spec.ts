import { expect, test } from '@playwright/test';

/**
 * The desktop shell mode: `data-shell='desktop'`.
 *
 * No committed browser test installed the desktop bridge, so the layout the app
 * actually ships with — where the renderer reserves 148px on the right of the title
 * bar for the native minimise/maximise/close buttons — was never rendered by any
 * test. The browser suite only ever exercised the plain web build.
 *
 * That reserve is what keeps the page's own controls from sitting under the OS
 * buttons, so a mistake there is invisible in every other test and obvious to a user.
 */
test('reserves the native window-button gutter only in desktop shell mode', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const overlayCalls: Array<{ color: string; symbolColor: string }> = [];
  const commands: string[] = [];

  await page.addInitScript(() => {
    (window as unknown as { selbstlaufDesktop: unknown }).selbstlaufDesktop = {
      platform: 'win32',
      versions: { electron: '44.4.1', chrome: '140.0.0.0', node: '22.0.0' },
      shell: {
        reload: () => {},
        toggleFullScreen: () => {},
        zoom: () => {},
        quit: () => {},
        openExternal: () => {},
        // The renderer reports the colour it actually painted so the native strip
        // can follow a custom palette or the light theme.
        setTitleBarOverlay: (options: { color: string; symbolColor: string }) => {
          (window as unknown as { __overlayCalls: unknown[] }).__overlayCalls ??= [];
          (window as unknown as { __overlayCalls: unknown[] }).__overlayCalls.push(options);
        },
      },
      settings: {
        get: async () => ({ closeToTray: true, preferredTerminal: null }),
        set: async () => ({ closeToTray: true, preferredTerminal: null }),
      },
      onCommand: (handler: (payload: { command?: string; section?: string }) => void) => {
        (window as unknown as { __commandHandler?: (p: { command?: string; section?: string }) => void }).__commandHandler = handler;
        return () => {};
      },
    };
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  // The shell must have switched itself into desktop mode.
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'desktop');

  const titlebar = page.locator('.titlebar');
  const paddingRight = await titlebar.evaluate((el) => getComputedStyle(el).paddingRight);
  expect(paddingRight, 'the native button gutter must be reserved').toBe('148px');

  // Concretely: the last page control must end before the native buttons begin.
  const windowWidth = 1280;
  const gutterStart = windowWidth - 148;
  const menus = await titlebar.locator('.titlebar__menu-button').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { right: Math.round(r.right) };
  }));
  for (const menu of menus) {
    expect(menu.right, 'a title-bar control intrudes into the native button area').toBeLessThanOrEqual(gutterStart);
  }

  // The renderer reports the colour it painted, so the strip follows the theme.
  const painted = await titlebar.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.waitForTimeout(400);
  const calls = await page.evaluate(() => (window as unknown as { __overlayCalls?: Array<{ color: string; symbolColor: string; height?: number }> }).__overlayCalls ?? []);
  expect(calls.length, 'the renderer must report its overlay colour to the main process').toBeGreaterThan(0);

  // Convert the reported colour to the same form the browser computed.
  const toRgb = (hex: string) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex.trim());
    if (m === null) return null;
    return `rgb(${Number.parseInt(m[1], 16)}, ${Number.parseInt(m[2], 16)}, ${Number.parseInt(m[3], 16)})`;
  };
  const last = calls[calls.length - 1];
  const reported = toRgb(last.color);
  expect(reported, `the reported colour must be a hex triple: ${last.color}`).not.toBeNull();
  expect(
    reported,
    'the colour reported to the main process must be the colour the page painted',
  ).toBe(painted);

  // The named commands from the menu bar and the tray must reach the app. This is
  // the same channel the tray's 打开主界面 / 设置 items use.
  await page.evaluate(() => {
    (window as unknown as { __commandHandler?: (p: { command?: string; section?: string }) => void })
      .__commandHandler?.({ command: 'open-settings' });
  });
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();

  // A section-scoped command opens that section directly, which is how the tray's
  // 设置 item and the account shortcut both arrive.
  await page.evaluate(() => {
    (window as unknown as { __commandHandler?: (p: { command?: string; section?: string }) => void })
      .__commandHandler?.({ command: 'open-settings', section: 'account' });
  });
  const rail = page.getByRole('tablist', { name: '设置分区' });
  await expect(rail.getByRole('tab', { name: '关于' })).toHaveAttribute('aria-selected', 'true');

  // Returning to the dashboard uses the same channel.
  await page.evaluate(() => {
    (window as unknown as { __commandHandler?: (p: { command?: string; section?: string }) => void })
      .__commandHandler?.({ command: 'back-to-app' });
  });
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('desktop-shell-mode.png'), fullPage: true });

  // Below the 700px breakpoint the reserve is released, since the native buttons
  // have no room to spare. The checkbox above already proved 900px keeps the full
  // gutter, so this pins only the released case.
  await page.setViewportSize({ width: 640, height: 900 });
  await page.waitForTimeout(200);
  const narrowPadding = await page.locator('.titlebar').evaluate((el) => getComputedStyle(el).paddingRight);
  expect(narrowPadding, 'the gutter must be released below 700px').toBe('4px');

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  void commands;
});