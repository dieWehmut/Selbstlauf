import { expect, test } from '@playwright/test';

/**
 * Every settings section must render without throwing.
 *
 * The rail advertises 18 sections, but the suite only ever clicked four of them,
 * so a section that threw on mount — a bad prop, a missing guard, an unavailable
 * browser API — would have shipped unseen. React unmounts the whole tree on an
 * uncaught render error, so the symptom would be a blank settings page with no
 * obvious cause.
 *
 * This walks all of them and requires each to produce a heading and no page error.
 */
test('renders every settings section without a page error', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();

  const rail = page.getByRole('tablist', { name: '设置分区' });
  await expect(rail).toBeVisible();

  const labels = await rail.getByRole('tab').allTextContents();
  expect(labels).toHaveLength(18);

  const failures: string[] = [];
  for (const label of labels) {
    await rail.getByRole('tab', { name: label, exact: true }).click();
    // The selected tab drives the panel; a throw leaves nothing rendered.
    await expect(rail.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(150);

    // Report the section that produced nothing, with its own name attached, rather
    // than aborting on the first one.
    const html = await page.locator('.settings-content').innerHTML();
    if (html.trim().length === 0) {
      failures.push(`${label}: rendered an empty panel`);
      continue;
    }
    const heading = await page.locator('.settings-content h2').first().textContent();
    if (heading === null || heading.trim().length === 0) {
      failures.push(`${label}: no heading rendered`);
    }
  }

  expect(failures, `sections that did not render:\n  ${failures.join('\n  ')}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);

  await page.screenshot({ path: testInfo.outputPath('settings-all-sections.png'), fullPage: true });
});