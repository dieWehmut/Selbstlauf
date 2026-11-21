import { expect, test } from '@playwright/test';

/**
 * The window preview on a process detail page, in the browser build.
 *
 * The browser build has no desktop bridge, so this cannot exercise a real capture — that is
 * covered by the desktop unit tests and by driving the packaged app. What it does cover is the
 * state the *user* sees when there is nothing to capture, which must be an explanation rather
 * than an empty frame: a browser tab has no window capturer at all, and a panel that simply
 * showed nothing would read as a broken feature.
 */
test('the detail page explains that this environment cannot preview windows', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  // Open a process from the sidebar so the detail page renders.
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();

  const panel = page.locator('.window-preview');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.window-preview__title')).toContainText('窗口内容');

  // No capturer here, so the panel says so instead of showing an empty frame.
  await expect(panel.locator('.window-preview__note')).toContainText(/不支持窗口预览|不能预览窗口/u);
  await expect(panel.locator('.window-preview__image')).toHaveCount(0);

  // The refresh control is present but must not pretend to work; the switch button exists.
  await expect(panel.getByRole('button', { name: '刷新窗口预览' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /切换到该窗口/u })).toBeVisible();

  // The panel must not introduce horizontal overflow at a narrow width either.
  await page.setViewportSize({ width: 700, height: 704 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `the preview panel overflows by ${overflow}px`).toBeLessThanOrEqual(1);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

for (const wording of [
  { locale: 'zh-CN', unconfirmed: '未确认已恢复最小化', confirmed: '已临时显示后还原' },
  { locale: 'zh-TW', unconfirmed: '未確認已重新縮小', confirmed: '已暫時顯示後還原' },
  { locale: 'en', unconfirmed: 'minimization afterward was not confirmed', confirmed: 'then restored' },
  { locale: 'ja', unconfirmed: '再度の最小化は確認できませんでした', confirmed: '一時表示して元に戻しました' },
] as const) {
  test(`desktop preview reports cleanup confirmation accurately in ${wording.locale}`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.addInitScript((locale) => {
      const preferences = { closeToTray: true, preferredTerminal: null, locale };
      const requests: string[] = [];
      const cleanup: { minimizedAgain?: boolean } = { minimizedAgain: false };
      (window as unknown as { __previewRequests: string[] }).__previewRequests = requests;
      (window as unknown as { __previewCleanup: typeof cleanup }).__previewCleanup = cleanup;
      (window as unknown as { selbstlaufDesktop: unknown }).selbstlaufDesktop = {
        platform: 'win32',
        versions: { electron: '44.4.1', chrome: '140.0.0.0' },
        settings: {
          get: async () => preferences,
          onChange: () => () => {},
        },
        shell: {
          setTitleBarOverlay: () => {},
          windowPreview: async (sessionId: string) => {
            requests.push(sessionId);
            return {
              state: 'captured',
              dataUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><text x="20" y="40">Window preview</text></svg>')}`,
              width: 960,
              height: 600,
              sharedBy: 1,
              restoredFromMinimized: true,
              ...(cleanup.minimizedAgain === undefined ? {} : { minimizedAgain: cleanup.minimizedAgain }),
            };
          },
        },
        onCommand: () => () => {},
      };
    }, wording.locale);

    await page.setViewportSize({ width: 1249, height: 704 });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', wording.locale);
    await page.locator('.sidebar-row__open').first().click();

    const panel = page.locator('.window-preview');
    const caption = panel.locator('.window-preview__caption');
    const image = panel.locator('img');
    const refresh = panel.locator('.window-preview__actions button').first();
    await expect(image).toBeVisible();
    await expect(caption).toContainText(wording.unconfirmed);
    await expect(caption).not.toContainText(wording.confirmed);
    const originalSource = await image.getAttribute('src');

    const requestCount = () => page.evaluate(() => (
      window as unknown as { __previewRequests: string[] }
    ).__previewRequests.length);
    const initialRequests = await requestCount();
    await page.evaluate(() => {
      delete (window as unknown as { __previewCleanup: { minimizedAgain?: boolean } }).__previewCleanup.minimizedAgain;
    });
    await refresh.click();
    await expect.poll(requestCount).toBe(initialRequests + 1);
    await expect(refresh).toBeEnabled();
    await expect(caption).toContainText(wording.unconfirmed);
    await expect(caption).not.toContainText(wording.confirmed);
    await expect(image).toHaveAttribute('src', originalSource!);

    // The longer explanation must also wrap within the detail page at narrow widths.
    await page.setViewportSize({ width: 700, height: 704 });
    await expect(image).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ))).toBeLessThanOrEqual(1);
    await caption.scrollIntoViewIfNeeded();
    await expect(caption).toBeInViewport();
    expect(await caption.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('unconfirmed-preview-narrow.png'), fullPage: true });

    await page.evaluate(() => {
      (window as unknown as { __previewCleanup: { minimizedAgain?: boolean } }).__previewCleanup.minimizedAgain = true;
    });
    await refresh.click();
    await expect(caption).toContainText(wording.confirmed);
    await expect(caption).not.toContainText(wording.unconfirmed);
    await expect(image).toHaveAttribute('src', originalSource!);
    const requests = await page.evaluate(() => (
      window as unknown as { __previewRequests: string[] }
    ).__previewRequests);
    expect(requests).toHaveLength(initialRequests + 2);
    expect(requests[0]).not.toBe('');
    expect(new Set(requests).size).toBe(1);
    expect(pageErrors).toEqual([]);
  });
}
