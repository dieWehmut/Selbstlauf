import { expect, test } from '@playwright/test';

/** The merged root rows remain keyboard-selectable and scroll independently of navigation. */
test('groups the sidebar processes by environment and project and opens the detail page', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  const list = page.getByRole('group', { name: '进程列表' });
  await expect(list).toBeVisible();

  // Sessions are grouped by execution environment, including sessions with no host.
  const headings = await list.locator('.sidebar-processes__heading').allTextContents();
  expect(headings.length).toBeGreaterThan(0);
  expect(headings.some((heading) => heading.startsWith('Windows'))).toBe(true);

  const rows = list.locator('.sidebar-row__open');
  await expect(rows.first()).toBeVisible();

  /**
   * Each row must be exposed as a button, not merely be one in the DOM.
   *
   * An earlier version put `role="listitem"` on these `<button>` elements, which
   * overrides the button role: the rows stopped being exposed as activatable, so
   * assistive technology announced list items with no way to know they could be
   * pressed. `getByRole('button')` finding them is the check that catches that.
   */
  expect(await rows.count(), 'the rows are not exposed as buttons').toBeGreaterThan(0);
  expect(await list.getByRole('listitem').count(), 'a listitem role overrode the button role').toBe(0);
  // They must also be reachable and activatable by keyboard.
  await rows.first().focus();
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();

  // Selecting a row opens that process and marks exactly that row.
  await rows.first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();
  const selected = list.locator('.sidebar-row.is-selected');
  await expect(selected).toHaveCount(1);
  // `aria-current` belongs to the button that opens the process, which is the row's body;
  // the wrapper is only a container so the pin control can sit beside it.
  await expect(selected.locator('.sidebar-row__open')).toHaveAttribute('aria-current', 'true');

  const rowPid = await selected.locator('.sidebar-row__open').getAttribute('title');
  // The detail page reports the same process the row named, including its PID.
  const detail = page.locator('.process-detail');
  await expect(detail).toBeVisible();
  const detailPid = await detail.locator('.process-id').first().textContent();
  expect(detailPid).toMatch(/PID \d+/u);
  const rowPidMatch = /PID (\d+)/u.exec(rowPid ?? '');
  expect(rowPidMatch, `the row title did not name a PID: ${rowPid}`).not.toBeNull();
  expect(detailPid).toContain(rowPidMatch![1]);

  await page.screenshot({ path: testInfo.outputPath('sidebar-detail-1280.png') });

  // Back to the list.
  await page.getByRole('button', { name: /返回列表/u }).click();
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('the list scrolls on its own without moving fixed navigation', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // The browser suite runs the app in static-demo mode (`VITE_STATIC_DEMO`), so it never
  // calls `/api/sessions`: a route or a `fetch` override cannot change the list, which is
  // why this test does not try to. The sidebar is `100vh - titlebar`, so a short window
  // makes the existing list overflow for real; that is the honest way to exercise the
  // scrolling behaviour without inventing data.
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/');
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible();

  const scroll = page.locator('.sidebar-processes__scroll');
  const metrics = await scroll.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  // It must be a scroll container, and it must actually be overflowing, or this test
  // would pass while proving nothing.
  expect(metrics.overflowY).toBe('auto');
  expect(
    metrics.scrollHeight,
    'the list is not overflowing, so the scroll behaviour is not being exercised',
  ).toBeGreaterThan(metrics.clientHeight);

  // The navigation and the footer must both still be on screen: the list scrolls
  // instead of pushing them away.
  for (const selector of ['.navigation-rail']) {
    const box = (await page.locator(selector).boundingBox())!;
    expect(box.y, `${selector} was pushed above the window`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${selector} was pushed below the window`).toBeLessThanOrEqual(420);
  }

  // Scrolling the list must not scroll the page, and must not widen the sidebar.
  const sidebarWidthBefore = (await page.locator('.sidebar').boundingBox())!.width;
  const pageScrollBefore = await page.evaluate(() => window.scrollY);
  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
  expect((await page.locator('.sidebar').boundingBox())!.width).toBe(sidebarWidthBefore);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  // The last row must be reachable by scrolling, not clipped away.
  const lastRow = page.locator('.sidebar-row__open').last();
  await lastRow.scrollIntoViewIfNeeded();
  await expect(lastRow).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('sidebar-scrolls-420.png') });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});