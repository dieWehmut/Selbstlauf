import { expect, test } from '@playwright/test';

/**
 * The sidebar has no header block, and every process row names its conversation.
 *
 * Two requests, both structural:
 *
 *  1. the brand box at the top of the sidebar is gone — it repeated the app's own name on
 *     every page without carrying anything actionable;
 *  2. each process row shows which conversation it is in, not only the selected one,
 *     because that is what decides whether continuing the process makes sense.
 *
 * The drawer's close control is asserted too: removing the header left it as the sidebar's
 * only first child, and `.icon-button` (`display: inline-grid`, later in the stylesheet)
 * outranked `.sidebar-close` (`display: none`) at equal specificity — so it appeared at
 * column widths where there is no drawer, and pushed the navigation down a row.
 */
test('has no brand header, and every process row names its conversation', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();

  // 1. No brand block at the top, and the app's name is not in the sidebar.
  await expect(page.locator('.sidebar > .brand'), 'the brand box is still at the top').toHaveCount(0);
  expect(await page.locator('.sidebar').getByText('Selbstlauf').count()).toBe(0);
  // The identity moved into the bottom bar's popup rather than being dropped.
  await page.locator('.account-bar__button').click();
  const region = page.getByRole('region', { name: '账户与状态' });
  await expect(region).toContainText('Selbstlauf');
  await page.keyboard.press('Escape');

  // The close control belongs to the drawer, so it is not shown where there is no drawer.
  const close = page.locator('.sidebar > .sidebar-close');
  await expect(close).toBeHidden();
  // And the navigation starts at the top of the column, not below a wasted row.
  const navBox = (await page.locator('.sidebar nav').boundingBox())!;
  expect(navBox.y, 'the navigation is pushed down below an empty header row').toBeLessThan(80);

  // 2. Every row carries a conversation, not just the selected one.
  const list = page.getByRole('group', { name: '进程列表' });
  const rows = list.locator('.sidebar-processes__item');
  const count = await rows.count();
  expect(count, 'no processes to check').toBeGreaterThan(0);
  const conversations = await list.locator('.sidebar-processes__conversation').allTextContents();
  expect(conversations, 'not every row has a conversation line').toHaveLength(count);
  for (const text of conversations) {
    // A conversation is either a real id or the explicit 未关联, never blank.
    expect(text.trim().length, 'a conversation line is empty').toBeGreaterThan(0);
  }

  // Each row also says where it runs, so a row is identifiable without clicking it.
  const wheres = await list.locator('.sidebar-processes__where').allTextContents();
  expect(wheres).toHaveLength(count);
  for (const text of wheres) expect(text).toMatch(/PID \d+/u);

  await page.screenshot({ path: testInfo.outputPath('sidebar-no-brand-with-conversations.png') });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('the sidebar conversation agrees with the process table for the same session', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.process-table')).toBeVisible();

  // Both views read one helper, so a session's conversation must read the same in each.
  // The table splits the label and the id into two elements; the sidebar shows them as one
  // line with a separator, so the two are compared part by part rather than as whole
  // strings that would only be testing the punctuation.
  const tableRows = await page.locator('.process-table tbody tr').evaluateAll((trs) => trs.map((tr) => {
    const cells = tr.querySelectorAll('td');
    return {
      tool: cells[0]?.querySelector('strong')?.textContent?.trim() ?? '',
      label: cells[3]?.querySelector('strong')?.textContent?.trim() ?? '',
      id: cells[3]?.querySelector('span')?.textContent?.trim() ?? '',
    };
  }));
  const sidebarRows = await page.locator('.sidebar-processes__item').evaluateAll((els) => els.map((el) => {
    const conversation = el.querySelector('.sidebar-processes__conversation')?.textContent?.trim() ?? '';
    // Split on the *last* separator: a label may itself contain one, as `Goal · active` does.
    const cut = conversation.lastIndexOf('·');
    return {
      tool: el.querySelector('.sidebar-processes__name')?.textContent?.trim() ?? '',
      label: cut === -1 ? conversation : conversation.slice(0, cut).trim(),
      id: cut === -1 ? '' : conversation.slice(cut + 1).trim(),
    };
  }));

  expect(tableRows.length).toBeGreaterThan(0);
  expect(sidebarRows.length).toBe(tableRows.length);
  for (const sidebar of sidebarRows) {
    const match = tableRows.find((row) => row.tool === sidebar.tool
      && row.label === sidebar.label
      && row.id === sidebar.id);
    expect(
      match,
      `no table row matches the sidebar's ${sidebar.tool} / ${sidebar.label} / ${sidebar.id}`,
    ).toBeDefined();
  }

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});