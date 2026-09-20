import { expect, test } from '@playwright/test';

/**
 * The layout holds across every breakpoint, on every page.
 *
 * Breakpoint boundaries are where layout regressions hide: the rule that applies one pixel
 * either side of them is different, and each side had only ever been checked at the two or
 * three widths an existing test happened to use. This sweeps both sides of 700 and 960 —
 * the two the stylesheet declares — plus the extremes, and checks each page for horizontal
 * overflow, a missing or collapsed key element, and anything extending past the right edge.
 *
 * It found nothing when added, which is the result worth recording: the layout is sound
 * across the range rather than only at the widths already covered.
 */
const WIDTHS = [320, 360, 480, 640, 699, 700, 701, 760, 900, 959, 960, 961, 1024, 1249, 1440, 1920];

// Sixteen widths across four pages is far past the default budget, and the sweep is the point.
test.setTimeout(240_000);

test('every page holds its layout across the breakpoint boundaries', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const problems: string[] = [];

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.waitForTimeout(250);

    const check = async (label: string, selectors: readonly string[]) => {
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`${width}px ${label}: horizontal overflow ${overflow}px`);
      for (const sel of selectors) {
        const locator = page.locator(sel).first();
        if (await page.locator(sel).count() === 0) {
          problems.push(`${width}px ${label}: ${sel} missing`);
          continue;
        }
        const box = await locator.boundingBox();
        if (box === null) {
          problems.push(`${width}px ${label}: ${sel} has no box`);
          continue;
        }
        if (box.width <= 0 || box.height <= 0) {
          problems.push(`${width}px ${label}: ${sel} collapsed (${Math.round(box.width)}x${Math.round(box.height)})`);
        }
        if (box.x + box.width > width + 2) {
          problems.push(`${width}px ${label}: ${sel} extends ${Math.round(box.x + box.width - width)}px past the right edge`);
        }
        // No left-edge check here: the settings rail is deliberately parked off-canvas with
        // a transform while its drawer is closed, and that is asserted separately below.
      }
    };

    await check('进程', ['.titlebar', '.topbar', '.metric-strip', '.workspace']);
    expect(await page.locator('.sidebar').count(), `${width}px: no left column`).toBeGreaterThan(0);

    await page.keyboard.press('Control+2');
    await page.waitForTimeout(250);
    await check('事件', ['.titlebar', '.topbar', '.timeline']);

    await page.keyboard.press('Control+3');
    await page.waitForTimeout(200);
    await check('设置', ['.titlebar', '.topbar', '.settings-content', '.settings-rail']);
    // Above the drawer breakpoint the rail is the column, so it must be on screen; below it
    // is a drawer, positioned off-canvas with a transform. `isVisible()` is deliberately not
    // used: it returns true for off-canvas, since it only means "not display:none".
    const railBox = await page.locator('.settings-rail').boundingBox();
    const onScreen = railBox !== null && railBox.x + railBox.width > 0 && railBox.x < width;
    if (width >= 961 && !onScreen) problems.push(`${width}px 设置: rail is not on screen as the column`);
    if (width < 961 && onScreen) problems.push(`${width}px 设置: rail is on screen although the drawer is closed`);

    await page.keyboard.press('Control+1');
    await page.waitForTimeout(200);
    if (width < 961) {
      await page.getByRole('button', { name: '打开菜单' }).click();
      await page.waitForTimeout(200);
    }
    const row = page.locator('.sidebar-row__open').first();
    expect(await row.count(), `${width}px: no process row to open`).toBeGreaterThan(0);
    await row.click();
    await page.waitForTimeout(300);
    await check('进程详情', ['.titlebar', '.topbar', '.process-detail']);
    const heading = await page.locator('h1').first().textContent();
    if (!heading?.includes('进程详情')) problems.push(`${width}px 进程详情: heading is "${heading}"`);
  }

  expect(problems, `layout problems:\n  ${problems.join('\n  ')}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});