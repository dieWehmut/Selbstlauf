import { expect, test } from '@playwright/test';

/**
 * The desktop pet has to be where its section says it is.
 *
 * 宠物 promises "在窗口右下角显示一个小小的状态装饰", and the ornament used to be rendered by that settings
 * section — so it appeared only while the section was open, and the corner it claimed was a corner of the
 * settings page. `position: fixed` in its stylesheet says the window's corner; this measures the box
 * against the viewport, on two different pages, rather than trusting the class name.
 */
test('the desktop pet sits in the window corner, on every page', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('watchdog-pet', JSON.stringify({ enabled: true, form: 'ring' }));
  });
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  const pet = page.locator('.workspace-pet');
  await expect(pet, 'the pet is missing from the overview').toBeVisible();
  await expect(pet).toHaveClass(/workspace-pet--ring/u);

  const corners = async () => {
    // The ornament eases its transform, so a mid-transition box is not the settled one.
    let previous = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = JSON.stringify(await pet.evaluate((element) => {
        const style = getComputedStyle(element);
        return { transform: style.transform, transition: style.transitionProperty };
      }));
      if (current === previous) break;
      previous = current;
      await page.waitForTimeout(50);
    }
    const box = await pet.boundingBox();
    const view = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const classes = await pet.getAttribute('class');
    if (box === null) throw new Error('the pet has no box');
    return {
      right: Math.round(view.width - (box.x + box.width)),
      bottom: Math.round(view.height - (box.y + box.height)),
      width: Math.round(box.width),
      classes: classes ?? '',
    };
  };

  const overview = await corners();
  console.log(`overview: ${overview.width}px square, ${overview.right}px from the right, ${overview.bottom}px from the bottom, [${overview.classes}]`);
  expect(overview.width, 'the pet is not the size the stylesheet sets').toBeGreaterThan(40);
  expect(overview.right, 'the pet is not near the right edge').toBeLessThanOrEqual(40);
  expect(overview.bottom, 'the pet is not near the bottom edge').toBeLessThanOrEqual(40);

  // The page changes, the ornament does not: that is the point of drawing it in the shell.
  await page.locator('.sidebar').getByRole('button', { name: '事件' }).click();
  await expect(page.getByRole('heading', { name: '事件记录' })).toBeVisible();
  await expect(pet, 'the pet vanished on another page').toBeVisible();
  const events = await corners();
  console.log(`events page: ${events.width}px square, ${events.right}px from the right, ${events.bottom}px from the bottom, [${events.classes}]`);
  expect(events.right).toBe(overview.right);
  expect(events.bottom).toBe(overview.bottom);
});