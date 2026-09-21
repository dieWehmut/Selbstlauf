import { expect, test } from '@playwright/test';

/**
 * Every scrolling region carries the same themed scrollbar.
 *
 * Measured on the installed app before this was fixed: only one of four scrolling containers was themed, and
 * `.workspace` — the main column, which is scrolled constantly — rendered a **15px browser-default bar** with
 * `scrollbar-color: auto`. A default bar beside themed ones reads as a rendering fault rather than a surface.
 *
 * The check is on the computed style rather than on a screenshot, because a scrollbar's appearance cannot be
 * asserted from pixels reliably; what matters is that no region is left on the default.
 */
test('every scrolling region shares one themed scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  // Open a process detail page, which is what makes the main column scroll.
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();
  await page.waitForTimeout(400);

  const regions = await page.evaluate(() => {
    const out: { selector: string; overflowing: boolean; scrollbarColor: string; scrollbarWidth: string; reserved: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('*')) {
      const style = getComputedStyle(el);
      if (!['auto', 'scroll'].includes(style.overflowY) && !['auto', 'scroll'].includes(style.overflowX)) continue;
      out.push({
        selector: el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).join('.')
          : el.tagName.toLowerCase(),
        overflowing: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
        scrollbarColor: style.scrollbarColor,
        scrollbarWidth: style.scrollbarWidth,
        // How much layout width the scrollbar occupies.
        reserved: Math.round(el.offsetWidth - el.clientWidth),
      });
    }
    return out;
  });

  console.log(`scrolling regions: ${regions.length}`);
  for (const region of regions) {
    console.log(`  ${region.selector}: overflowing=${region.overflowing} reserved=${region.reserved}px color=${region.scrollbarColor}`);
  }

  // At least the sidebar and the main column scroll in this app.
  expect(regions.length, 'no scrolling region was found, so this proves nothing').toBeGreaterThanOrEqual(2);

  // None may be left on the browser default: that is the defect that was reported.
  const unthemed = regions.filter((region) => region.scrollbarColor === 'auto' && region.scrollbarWidth === 'auto');
  expect(unthemed.map((region) => region.selector), 'these regions still render a default scrollbar').toEqual([]);

  // And each declares the thin width, so the bar is quiet rather than 15px of chrome.
  for (const region of regions) {
    expect(region.scrollbarWidth, `${region.selector} is not thin`).toBe('thin');
  }

  // A reserved gutter would push the flush footer off the sidebar's edge, which is a separate pinned rule.
  const sidebar = regions.find((region) => region.selector === '.sidebar');
  if (sidebar) {
    expect(sidebar.reserved, 'the sidebar reserves gutter space, which breaks the flush footer').toBeLessThanOrEqual(1);
  }
});

test('the main column, not just the sidebar, is themed', async ({ page }) => {
  // This is the specific region that was wrong: it is the one a person scrolls most, and it was the only
  // measured region with a 15px default bar.
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();
  await page.waitForTimeout(400);

  const workspace = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.workspace');
    if (el === null) return null;
    const style = getComputedStyle(el);
    return {
      scrollbarColor: style.scrollbarColor,
      scrollbarWidth: style.scrollbarWidth,
      overflowing: el.scrollHeight > el.clientHeight + 1,
      reserved: Math.round(el.offsetWidth - el.clientWidth),
    };
  });

  expect(workspace, 'the main column was not found').not.toBeNull();
  console.log(`.workspace: ${JSON.stringify(workspace)}`);
  expect(workspace!.overflowing, 'the page does not scroll, so the scrollbar is not exercised').toBe(true);
  expect(workspace!.scrollbarColor, 'the main column still has a default scrollbar').not.toBe('auto');
  expect(workspace!.scrollbarWidth).toBe('thin');
  // A 10px themed bar, not the 15px default.
  expect(workspace!.reserved, `the scrollbar is ${workspace!.reserved}px wide`).toBeLessThanOrEqual(10);
});