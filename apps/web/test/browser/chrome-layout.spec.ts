import { expect, test } from '@playwright/test';

/** The list fills the sidebar, while only the window title bar stays pinned on scroll. */
test('the project list uses the space freed by the removed footer', async ({ page }) => {
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.account-bar, .account-popup')).toHaveCount(0);
  const sidebar = (await page.locator('.sidebar').boundingBox())!;
  const list = (await page.locator('.sidebar-processes__scroll').boundingBox())!;
  expect(sidebar.y + sidebar.height - list.y - list.height).toBeLessThanOrEqual(20);
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