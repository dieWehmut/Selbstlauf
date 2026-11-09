import { expect, test } from '@playwright/test';

/** Pins stay within their environment and project, including after a reload. */
test('pinning preserves project ancestry and survives reload', async ({ page }) => {
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  const list = page.getByRole('group', { name: '进程列表' });
  const target = list.locator('.sidebar-row').nth(1);
  const id = await target.getAttribute('data-session-id');
  const count = await list.locator('.sidebar-row').count();
  const project = await target.locator('..').getAttribute('data-project-id');
  await target.hover();
  await target.locator('.sidebar-row__pin').click();
  const pinned = list.locator(`[data-session-id="${id}"]`);
  await expect(pinned.locator('.sidebar-row__pin')).toHaveAttribute('aria-pressed', 'true');
  expect(await pinned.locator('..').getAttribute('data-project-id')).toBe(project);
  await expect(list.locator('.sidebar-row')).toHaveCount(count);
  await page.reload();
  await expect(pinned.locator('.sidebar-row__pin')).toHaveAttribute('aria-pressed', 'true');
  await pinned.locator('.sidebar-row__pin').click();
  await expect(pinned.locator('.sidebar-row__pin')).toHaveAttribute('aria-pressed', 'false');
});

test('fixed navigation remains visible when the project sidebar is collapsed', async ({ page }) => {
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  const rail = page.locator('.navigation-rail');
  await expect(rail).toBeVisible();
  const box = await rail.boundingBox();
  await page.locator('.titlebar').getByRole('button', { name: '收起侧栏' }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(rail).toBeVisible();
  expect(await rail.boundingBox()).toEqual(box);
});
