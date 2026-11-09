import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SETTINGS_CATEGORIES } from '../../src/settings/SettingsRail';

const evidenceDir = resolve(process.env.PAGES_SCREENSHOT_DIR ?? '../../tmp/settings-verification-20261022/pages/production');

async function screenshot(page: Page, name: string) {
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), fullPage: true, animations: 'disabled' });
}

async function openSettings(page: Page) {
  await page.keyboard.press('Control+,');
  await expect(page.locator('.settings-content')).toBeVisible();
}

async function section(page: Page, name: string) {
  // A selected section closes the mobile drawer, so its tab remains mounted but hidden.
  const tab = page.getByRole('tab', { name, exact: true, includeHidden: true });
  const drawer = page.locator('.sidebar--settings');
  if ((page.viewportSize()?.width ?? 1440) <= 960 && !await drawer.evaluate((element) => element.classList.contains('is-open'))) {
    await page.getByRole('button', { name: '打开菜单' }).click();
  }
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(drawer).not.toHaveClass(/is-open/);
  await expect(page.locator('.settings-content h2').first()).toBeVisible();
}

test('production subpath loads all settings at desktop, tablet and mobile widths', async ({ page }) => {
  const errors: string[] = [];
  const apiRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 820, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
    const assets = await page.locator('script[type="module"][src], link[rel="stylesheet"]').evaluateAll((elements) => elements.map((element) => element.getAttribute('src') ?? element.getAttribute('href')));
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.every((asset) => asset?.startsWith('/Selbstlauf/assets/'))).toBe(true);
    await screenshot(page, `overview-${viewport.width}`);
    await openSettings(page);
    await expect(page.locator('.settings-content')).toContainText('演示');
    for (const entry of SETTINGS_CATEGORIES.flatMap((category) => category.entries)) {
      await section(page, entry.label);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${entry.label} overflow at ${viewport.width}px`).toBeLessThanOrEqual(1);
      await screenshot(page, `${entry.id}-${viewport.width}`);
    }
  }
  expect(errors).toEqual([]);
  expect(apiRequests).toEqual([]);
});

test('saved config, integration states and personal settings survive production reloads', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./');
  await openSettings(page);
  await section(page, '常规');
  await page.getByRole('checkbox', { name: '启用自动续写', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: '监控 Claude Code', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Goal 状态 paused', exact: true }).uncheck();
  await page.getByLabel('轮询间隔（毫秒）').fill('4250');
  await page.getByLabel('Codex 普通对话', { exact: true }).fill('Pages 保存的提示词');
  await page.getByRole('checkbox', { name: 'Dry run', exact: true }).uncheck();
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByRole('status').getByText('配置已保存')).toBeVisible();
  await section(page, '启动与托盘');
  await page.getByRole('checkbox', { name: '开机自启', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: '关闭时最小化到托盘' })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '首选终端' })).toBeDisabled();
  await section(page, '续写与进程');
  await page.getByRole('button', { name: '安装 Stop Hook', exact: true }).click();
  await page.getByRole('checkbox', { name: '启用 Claude Stop Hook' }).check();
  await page.getByRole('button', { name: '保存配置' }).click();
  await page.locator('.codex-endpoints').getByRole('button', { name: 'https://www.sevnx.lol', exact: true }).click();
  await section(page, '关于');
  await page.getByRole('button', { name: '升级 Claude Code', exact: true }).click();
  await expect(page.getByTestId('tool-claude').getByText('2.1.276').first()).toBeVisible();
  await section(page, '个人资料');
  await page.getByLabel('显示名称').fill('Pages 验证');
  await section(page, '通知');
  await page.getByRole('checkbox', { name: '操作成功时提示' }).uncheck();
  await page.getByRole('spinbutton', { name: '保留最近事件条数' }).fill('12');
  await section(page, '电脑操控');
  await page.getByRole('checkbox').uncheck();
  await section(page, '宠物');
  await page.getByRole('checkbox', { name: '桌面宠物', exact: true }).check();
  await page.getByRole('combobox', { name: '形象' }).selectOption('ring');
  await section(page, '插件');
  await page.getByRole('textbox', { name: '手动续写提示词' }).fill('已保存的续写插件');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await section(page, '外观');
  await page.getByRole('radio', { name: '浅色', exact: true }).click();
  await screenshot(page, 'appearance-saved-light');

  await page.reload();
  await openSettings(page);
  await section(page, '常规');
  await expect(page.getByRole('checkbox', { name: '启用自动续写', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: '监控 Claude Code', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Goal 状态 paused', exact: true })).not.toBeChecked();
  await expect(page.getByLabel('轮询间隔（毫秒）')).toHaveValue('4250');
  await expect(page.getByLabel('Codex 普通对话', { exact: true })).toHaveValue('Pages 保存的提示词');
  await expect(page.getByRole('checkbox', { name: 'Dry run', exact: true })).not.toBeChecked();
  await screenshot(page, 'general-reloaded');
  await section(page, '启动与托盘');
  await expect(page.getByRole('checkbox', { name: '开机自启', exact: true })).toBeChecked();
  await section(page, '续写与进程');
  await expect(page.locator('.hook-settings').getByText('已安装', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '启用 Claude Stop Hook' })).toBeChecked();
  await expect(page.locator('.codex-endpoints').getByLabel('接口地址')).toHaveValue('https://www.sevnx.lol');
  await screenshot(page, 'integrations-reloaded');
  await section(page, '关于');
  await expect(page.getByTestId('tool-claude').getByText('当前版本', { exact: true })).toBeVisible();
  await section(page, '个人资料');
  await expect(page.getByLabel('显示名称')).toHaveValue('Pages 验证');
  await section(page, '通知');
  await expect(page.getByRole('checkbox', { name: '操作成功时提示' })).not.toBeChecked();
  await expect(page.getByRole('spinbutton', { name: '保留最近事件条数' })).toHaveValue('12');
  await section(page, '电脑操控');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await section(page, '宠物');
  await expect(page.getByRole('checkbox', { name: '桌面宠物', exact: true })).toBeChecked();
  await expect(page.getByRole('combobox', { name: '形象' })).toHaveValue('ring');
  await section(page, '插件');
  await expect(page.getByTestId('plugins-effective')).toContainText('已保存的续写插件');
  await section(page, '外观');
  await expect(page.getByRole('radio', { name: '浅色', exact: true })).toHaveAttribute('aria-checked', 'true');
  await screenshot(page, 'appearance-reloaded-light');
});

test('browser access opens the repository subpath and filtered rail remains keyboard reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./');
  await openSettings(page);
  await page.getByRole('searchbox', { name: '搜索设置' }).fill('托盘');
  const tab = page.getByRole('tab', { name: '启动与托盘' });
  await expect(tab).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('Tab');
  await expect(tab).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await screenshot(page, 'filtered-rail-keyboard');
  await page.getByRole('searchbox', { name: '搜索设置' }).fill('');
  await section(page, '浏览器');
  await expect(page.locator('.pref-row__value').first()).toContainText('/Selbstlauf/');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '在浏览器中打开' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(new URL(popup.url()).pathname).toBe('/Selbstlauf/');
  await expect(popup.getByRole('heading', { name: '进程监控' })).toBeVisible();
  await popup.close();
});

test('simulated uninstall removes startup and requires reinstall before starting again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./');
  await openSettings(page);
  await section(page, '常规');
  await page.getByRole('button', { name: '安装启动项', exact: true }).click();
  await expect(page.getByRole('button', { name: '移除启动项', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '卸载 Watchdog', exact: true }).click();
  await page.reload();
  await openSettings(page);
  await section(page, '常规');
  await expect(page.getByRole('button', { name: '安装启动项', exact: true })).toBeVisible();
  await page.locator('.settings-actions').getByRole('button', { name: '启动 Watchdog', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '演示 Watchdog 未安装' })).toBeVisible();
  await screenshot(page, 'watchdog-uninstalled');
  await page.getByRole('button', { name: '安装 Watchdog', exact: true }).click();
  await page.locator('.settings-actions').getByRole('button', { name: '启动 Watchdog', exact: true }).click();
  await expect(page.locator('.settings-actions').getByRole('button', { name: '停止 Watchdog', exact: true })).toBeVisible();
  await screenshot(page, 'watchdog-reinstalled');
});
