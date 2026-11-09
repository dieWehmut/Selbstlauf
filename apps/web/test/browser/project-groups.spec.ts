import { expect, test } from '@playwright/test';

test('merged root rows support environment collapse, search and real activity', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const list = page.getByRole('group', { name: '进程列表' });
  const ubuntu = list.locator('.sidebar-processes__group').filter({ has: page.locator('.sidebar-processes__heading', { hasText: 'Ubuntu' }) });
  const row = page.locator('[data-session-id="codex:336756"]');
  await expect(ubuntu).toContainText('Selbstlauf');
  await expect(row.locator('.agent-activity')).toHaveText('运行中');
  await expect(page.locator('[data-session-id="claude:214052"] .agent-activity')).toHaveText('空闲');
  await expect(page.locator('.account-bar, .account-popup, .sidebar-tools, .sidebar-project__heading')).toHaveCount(0);
  await expect(row.locator('.sidebar-row__label')).toHaveText('Selbstlauf');
  await expect(row.locator('.sidebar-row__path')).toHaveText('/home/han/project/Selbstlauf');
  const environment = ubuntu.locator('.sidebar-processes__heading');
  await environment.click();
  await expect(row).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: '搜索进程' });
  await search.fill('/home/han/project/Selbstlauf');
  await expect(row).toBeVisible();
  await expect(list.locator('.sidebar-row')).toHaveCount(1);
  await search.fill('优化侧栏');
  await expect(row).toBeVisible();
  await row.locator('.sidebar-row__open').click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('14px "LXGW WenKai"'))).toBe(true);
  expect(await page.locator('.sidebar-row__path').first().evaluate((el) => getComputedStyle(el).fontFamily)).toContain('LXGW WenKai');
  expect(errors).toEqual([]);
});

test('fixed navigation survives collapse and scroll, and mobile settings shortcuts dismiss the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('/');
  const navigation = page.locator('.navigation-rail');
  const before = await navigation.boundingBox();
  await page.locator('.workspace').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await navigation.boundingBox()).toEqual(before);
  await page.locator('.titlebar').getByRole('button', { name: '收起侧栏' }).click();
  await expect(navigation).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await expect(navigation).toBeVisible();
  await page.setViewportSize({ width: 700, height: 850 });
  for (const label of ['插件', '宠物', '设置']) {
    await page.getByRole('button', { name: '打开菜单' }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await navigation.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(navigation).toBeVisible();
    if (label !== '设置') await expect(page.locator('.settings-content').getByRole('heading', { name: label === '插件' ? '续写插件' : '桌面宠物', exact: true })).toBeVisible();
  }
});
