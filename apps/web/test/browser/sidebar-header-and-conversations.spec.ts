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
  const rows = list.locator('.sidebar-row__open');
  const count = await rows.count();
  expect(count, 'no processes to check').toBeGreaterThan(0);
  const conversations = await list.locator('.sidebar-row__conversation').allTextContents();
  expect(conversations, 'not every row has a conversation line').toHaveLength(count);
  for (const text of conversations) {
    // A conversation is either a real id or the explicit 未关联, never blank.
    expect(text.trim().length, 'a conversation line is empty').toBeGreaterThan(0);
  }

  // Each row also shows its silence, so a row is identifiable without clicking it. The host
  // is deliberately not repeated on the row: it is the group heading directly above it.
  const metas = await list.locator('.sidebar-row__meta').allTextContents();
  expect(metas).toHaveLength(count);
  for (const text of metas) expect(text.trim().length).toBeGreaterThan(0);

  // Every row offers both of its actions.
  expect(await list.locator('.sidebar-row__pin').count()).toBe(count);
  const hostHeadings = await list.locator('.sidebar-processes__heading').allTextContents();
  expect(hostHeadings.length, 'no group headings to explain the rows').toBeGreaterThan(0);

  await page.screenshot({ path: testInfo.outputPath('sidebar-no-brand-with-conversations.png') });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('every word a row displays is searchable', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  const rows = page.locator('.sidebar-row__open');
  const total = await rows.count();
  expect(total).toBeGreaterThan(0);

  // Every distinct conversation label on screen, and every conversation id.
  //
  // The lines are the point: 普通对话, 未关联 and 等待输入 appear nowhere in a session's own
  // fields, so a search for them can only match if the *displayed* conversation line is in the
  // filter's haystack. An earlier version of this test searched the first row's label, which
  // happened to be "Goal" for a session whose conversationId was `demo-goal` — it passed with
  // the bug still present, because the id matched incidentally.
  const lines = await page.locator('.sidebar-row__conversation').allTextContents();
  // Skip a `Goal …` line: its label could match a session field by accident, which is exactly
  // the false pass this test was written to avoid.
  const probes = [...new Set(lines.map((line) => line.trim()))]
    .filter((line) => line.length > 0 && !line.startsWith('Goal'));
  expect(probes.length, 'every conversation line could match a session field by accident').toBeGreaterThan(0);

  const search = page.getByRole('searchbox', { name: '搜索进程' });
  for (const label of probes) {
    await search.fill(label);
    await expect
      .poll(async () => rows.count(), {
        message: `searching "${label}" found nothing, but that label is on a row`,
      })
      .toBeGreaterThan(0);
    // What survived must show that label, so the match is not incidental.
    for (const text of await rows.allTextContents()) {
      expect(text).toContain(label);
    }
  }

  // The filter must also still work on the fields it always matched.
  await search.fill('Tabby');
  await expect.poll(async () => rows.count()).toBeGreaterThan(0);

  await search.fill('');
  await expect(rows).toHaveCount(total);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('the sidebar conversation agrees with the process table for the same session', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.process-table')).toBeVisible();

  // Both views read one helper, so a session's conversation must agree in each. The table
  // splits the label and the id into two elements and shows the id in full; a compact sidebar
  // row shows one line with the id shortened. A shortened id may have had a shared type prefix
  // dropped — `session-4f21c0a8-…` shows as `4f21c0a8` — so the table's id must *contain* it
  // rather than equal it.
  const tableRows = await page.locator('.process-table tbody tr').evaluateAll((trs) => trs.map((tr) => {
    const cells = tr.querySelectorAll('td');
    return {
      tool: cells[0]?.querySelector('strong')?.textContent?.trim() ?? '',
      label: cells[3]?.querySelector('strong')?.textContent?.trim() ?? '',
      id: cells[3]?.querySelector('span')?.textContent?.trim() ?? '',
    };
  }));
  const sidebarRows = await page.locator('.sidebar-row__open').evaluateAll((els) => els.map((el) => {
    const conversation = el.querySelector('.sidebar-row__conversation')?.textContent?.trim() ?? '';
    // Split on the *last* separator: a label may itself contain one, as `Goal · active` does.
    const cut = conversation.lastIndexOf('·');
    return {
      tool: el.querySelector('.sidebar-row__label')?.textContent?.trim() ?? '',
      label: cut === -1 ? conversation : conversation.slice(0, cut).trim(),
      id: cut === -1 ? '' : conversation.slice(cut + 1).trim(),
    };
  }));

  expect(tableRows.length).toBeGreaterThan(0);
  expect(sidebarRows.length).toBe(tableRows.length);
  for (const sidebar of sidebarRows) {
    const match = tableRows.find((row) => row.tool === sidebar.tool
      && row.label === sidebar.label
      && (sidebar.id === '' ? row.id === '未关联' : row.id.includes(sidebar.id)));
    expect(
      match,
      `no table row matches the sidebar's ${sidebar.tool} / ${sidebar.label} / ${sidebar.id}`,
    ).toBeDefined();
  }

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});