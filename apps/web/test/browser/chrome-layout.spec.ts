import { expect, test } from '@playwright/test';

/**
 * Three layout changes asked for directly:
 *
 *  1. the bottom status bar sits flush in the sidebar's bottom corners — no gap at the sides or the
 *     bottom — and is shorter than a panel;
 *  2. the popup it opens is flush against that bar rather than floating above it with a gap;
 *  3. the page heading row scrolls away instead of staying pinned, so a scrolled page does not keep an
 *     empty strip across its top.
 *
 * Measured by geometry rather than by class name, because each of these is a statement about where
 * something is.
 */
test('the bottom bar sits flush in the sidebar corners and is shorter', async ({ page }) => {
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();

  const measured = await page.evaluate(() => {
    const bar = document.querySelector('.account-bar__button');
    const sidebar = document.querySelector('.sidebar');
    const b = bar!.getBoundingClientRect();
    const s = sidebar!.getBoundingClientRect();
    const style = getComputedStyle(bar!);
    return {
      gapLeft: Math.round(b.left - s.left),
      gapRight: Math.round(s.right - b.right),
      gapBottom: Math.round(s.bottom - b.bottom),
      height: Math.round(b.height),
      radius: style.borderRadius,
      borderTop: style.borderTopWidth,
    };
  });

  console.log(`bar: left gap ${measured.gapLeft}, right gap ${measured.gapRight}, bottom gap ${measured.gapBottom}, height ${measured.height}`);
  // Flush at the three edges: a pixel of rounding is acceptable, a padding-sized gap is not.
  expect(measured.gapLeft, 'the bar is inset from the left edge').toBeLessThanOrEqual(1);
  expect(measured.gapRight, 'the bar is inset from the right edge').toBeLessThanOrEqual(1);
  expect(measured.gapBottom, 'the bar is inset from the bottom edge').toBeLessThanOrEqual(1);
  // Shorter than the 51px card it used to be.
  expect(measured.height, 'the bar is still a tall panel').toBeLessThan(48);
  // Square at the corners it now reaches.
  expect(measured.radius).toBe('0px');
  console.log(`  flush and ${measured.height}px tall (was 51px)`);
});

test('the popup is flush against the bar it opens from', async ({ page }) => {
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.locator('.account-bar__button').click();
  await expect(page.locator('.account-popup')).toBeVisible();

  const measured = await page.evaluate(() => {
    const popup = document.querySelector('.account-popup');
    const bar = document.querySelector('.account-bar__button');
    const sidebar = document.querySelector('.sidebar');
    const p = popup!.getBoundingClientRect();
    const b = bar!.getBoundingClientRect();
    const s = sidebar!.getBoundingClientRect();
    const style = getComputedStyle(popup!);
    return {
      gapToBar: Math.round(b.top - p.bottom),
      gapLeft: Math.round(p.left - s.left),
      gapRight: Math.round(s.right - p.right),
      bottomRadius: style.borderBottomLeftRadius,
    };
  });

  console.log(`popup: ${measured.gapToBar}px above the bar, side gaps ${measured.gapLeft}/${measured.gapRight}, bottom radius ${measured.bottomRadius}`);
  expect(measured.gapToBar, 'the popup floats above the bar instead of touching it').toBeLessThanOrEqual(1);
  expect(measured.gapLeft, 'the popup is inset from the sidebar edge').toBeLessThanOrEqual(1);
  expect(measured.gapRight).toBeLessThanOrEqual(1);
  expect(measured.bottomRadius, 'the popup is rounded where it meets the bar').toBe('0px');
});

test('the page heading scrolls away while the title bar stays pinned', async ({ page }) => {
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();

  const before = await page.evaluate(() => {
    const t = document.querySelector('.topbar');
    const w = document.querySelector('.workspace');
    return { top: Math.round(t!.getBoundingClientRect().top), position: getComputedStyle(t!).position, scrollable: w!.scrollHeight > w!.clientHeight + 20 };
  });
  expect(before.position, 'the heading row is still sticky').toBe('static');
  console.log(`before scroll: heading top=${before.top}, position=${before.position}, page scrollable=${before.scrollable}`);

  // Scroll the workspace and check the heading moved while the window title bar did not.
  await page.evaluate(() => { document.querySelector('.workspace')!.scrollTop = 300; });
  await page.waitForTimeout(350);

  const after = await page.evaluate(() => {
    const t = document.querySelector('.topbar');
    const tb = document.querySelector('.titlebar');
    return {
      top: Math.round(t!.getBoundingClientRect().top),
      titlebarTop: Math.round(tb!.getBoundingClientRect().top),
      scrolled: document.querySelector('.workspace')!.scrollTop,
    };
  });
  console.log(`after scroll ${after.scrolled}: heading top=${after.top}, title bar top=${after.titlebarTop}`);

  // It must actually have moved: staying put would mean it is still pinned.
  expect(after.top, 'the heading row did not scroll away').toBeLessThan(before.top);
  // And the window's own title bar must still be at the top, since that is the thing that must stay.
  expect(after.titlebarTop, 'the title bar scrolled away, which it must not').toBe(0);
});