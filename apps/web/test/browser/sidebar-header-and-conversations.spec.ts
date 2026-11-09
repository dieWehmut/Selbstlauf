import { expect, test } from '@playwright/test';

/** The compact list keeps a root label, path, activity and age on every selectable session. */
test('has no brand header and gives every process one root directory row', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();

  // 1. No brand block at the top, and the app's name is not in the sidebar.
  await expect(page.locator('.sidebar > .brand'), 'the brand box is still at the top').toHaveCount(0);
  await expect(page.locator('.account-bar, .account-popup')).toHaveCount(0);

  // The close control belongs to the drawer, so it is not shown where there is no drawer.
  const close = page.locator('.sidebar > .sidebar-close');
  await expect(close).toBeHidden();
  // And the navigation starts at the top of the column, not below a wasted row.
  const navBox = (await page.locator('.navigation-rail').boundingBox())!;
  expect(navBox.y, 'the navigation is pushed down below an empty header row').toBeLessThan(80);

  // Every row carries its root path or an explicit process identity fallback.
  const list = page.getByRole('group', { name: '进程列表' });
  const rows = list.locator('.sidebar-row__open');
  const count = await rows.count();
  expect(count, 'no processes to check').toBeGreaterThan(0);
  const paths = await list.locator('.sidebar-row__path').allTextContents();
  expect(paths, 'not every row has a root path line').toHaveLength(count);
  for (const text of paths) {
    // Unknown roots keep a tool and PID, so the second line is never blank.
    expect(text.trim().length, 'a root path line is empty').toBeGreaterThan(0);
  }

  // The age and activity remain visible beside the directory.
  const metas = await list.locator('.sidebar-row__meta').allTextContents();
  expect(metas).toHaveLength(count);
  for (const text of metas) expect(text.trim().length).toBeGreaterThan(0);

  // Every row offers both of its actions.
  expect(await list.locator('.sidebar-row__pin').count()).toBe(count);
  const environmentHeadings = await list.locator('.sidebar-processes__heading').allTextContents();
  expect(environmentHeadings.length, 'no group headings to explain the rows').toBeGreaterThan(0);

  await page.screenshot({ path: testInfo.outputPath('sidebar-merged-root-rows.png') });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('every displayed root path or process identity is searchable', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  const rows = page.locator('.sidebar-row__open');
  const total = await rows.count();
  expect(total).toBeGreaterThan(0);

  const lines = await page.locator('.sidebar-row__path').allTextContents();
  const probes = [...new Set(lines.map((line) => line.trim()))].filter(Boolean);
  expect(probes.length, 'there are no displayed paths to search').toBeGreaterThan(0);

  const search = page.getByRole('searchbox', { name: '搜索进程' });
  for (const label of probes) {
    await search.fill(label);
    await expect
      .poll(async () => rows.count(), {
        message: `searching "${label}" found nothing, but that label is on a row`,
      })
      .toBeGreaterThan(0);
    // What survived must show that label, so the match is not incidental.
    expect((await rows.allTextContents()).some((text) => text.includes(label))).toBe(true);
  }

  // The filter must also still work on the fields it always matched.
  await search.fill('Tabby');
  await expect.poll(async () => rows.count()).toBeGreaterThan(0);

  await search.fill('');
  await expect(rows).toHaveCount(total);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('each sidebar title identifies the same process when opened', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const rows = page.locator('.sidebar-row');
  const ids = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')!));
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const row = page.locator(`[data-session-id="${id}"]`);
    const title = await row.locator('.sidebar-row__path').textContent();
    expect(title?.trim()).toBeTruthy();
    const hint = await row.locator('.sidebar-row__open').getAttribute('title');
    const pid = /PID (\d+)/u.exec(hint ?? '')?.[1];
    expect(pid).toBeTruthy();
    await row.locator('.sidebar-row__open').click();
    await expect(page.locator('.process-detail .process-id').first()).toContainText(`PID ${pid}`);
  }
});
