import { expect, test } from '@playwright/test';

test.describe('Selbstlauf watchdog workbench', () => {
  test('renders the desktop process table without horizontal overflow', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    await expect(page.getByText('Selbstlauf')).toBeVisible();
    await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
    await expect(page.locator('.process-table-wrap')).toBeVisible();
    await expect(page.locator('.session-cards')).toBeHidden();
    await expect(page.locator('.process-table tbody tr')).toHaveCount(3);
    await expect(page.getByRole('button', { name: '紧急停止' })).toBeVisible();
    await page.getByRole('button', { name: '紧急停止' }).click();
    await expect(page.getByRole('button', { name: '启动 Watchdog' })).toBeVisible();
    await page.getByRole('button', { name: '启动 Watchdog' }).click();
    await expect(page.getByRole('button', { name: '紧急停止' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await page.screenshot({ path: testInfo.outputPath('desktop-1440x900.png'), fullPage: true });
  });

  test('renders mobile process cards and a bounded keyboard-dismissable drawer', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await expect(page.locator('.process-table-wrap')).toBeHidden();
    await expect(page.locator('.session-cards')).toBeVisible();
    await expect(page.locator('.session-card')).toHaveCount(3);
    await expect(page.getByRole('button', { name: '紧急停止' })).toBeVisible();
    await page.getByRole('button', { name: '紧急停止' }).click();
    await expect(page.getByRole('button', { name: '启动 Watchdog' })).toBeVisible();
    await page.getByRole('button', { name: '启动 Watchdog' }).click();
    await expect(page.getByRole('button', { name: '紧急停止' })).toBeVisible();
    await page.getByRole('button', { name: '打开菜单' }).click();
    await expect(page.locator('.sidebar')).toHaveClass(/is-open/);
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

    await expect.poll(async () => Math.round((await page.locator('.sidebar').boundingBox())?.x ?? -999)).toBe(0);

    const drawer = await page.locator('.sidebar').boundingBox();
    expect(drawer).not.toBeNull();
    expect(drawer!.x).toBeGreaterThanOrEqual(0);
    expect(drawer!.x + drawer!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('mobile-390x844.png'), fullPage: true });

    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar')).not.toHaveClass(/is-open/);
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  });
});
