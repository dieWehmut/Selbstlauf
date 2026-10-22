import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const evidence = resolve(process.cwd(), '../../tmp/settings-verification-20261022/webui');

async function section(page: Page, label: string) {
  await expect(page.locator('.settings-content')).toBeVisible();
  const drawer = page.locator('.sidebar--settings');
  if ((page.viewportSize()?.width ?? 1280) <= 960 && !await drawer.evaluate((node) => node.classList.contains('is-open'))) {
    await page.getByRole('button', { name: '打开菜单' }).click();
  }
  await page.getByRole('tab', { name: label, exact: true }).click();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => undefined)));
  });
}

for (const theme of ['light', 'dark']) {
  for (const width of [1280, 390]) {
    test(`preferences persist and synchronize between real browser windows (${theme}, ${width})`, async ({ context, page }) => {
      await mkdir(evidence, { recursive: true });
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((theme) => { if (!localStorage.getItem('watchdog-theme')) localStorage.setItem('watchdog-theme', theme); }, theme);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
      await page.keyboard.press('Control+,');
      await section(page, '通知');
      const other = await context.newPage();
      await other.setViewportSize({ width, height: 900 });
      await other.goto('/');
      await expect(other.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
      await other.keyboard.press('Control+,');
      await section(other, '通知');
      await page.getByRole('checkbox', { name: '面板内通知' }).uncheck();
      await page.getByRole('spinbutton', { name: '保留最近事件条数' }).fill('23');
      await expect(other.getByRole('checkbox', { name: '面板内通知' })).not.toBeChecked();
      await expect(other.getByRole('spinbutton', { name: '保留最近事件条数' })).toHaveValue('23');
      await expect(page.getByRole('checkbox', { name: '面板内通知' })).not.toBeChecked();
      await page.screenshot({ path: resolve(evidence, `02-notifications-${theme}-${width}.png`), fullPage: true });
      await section(page, '外观');
      await section(other, '外观');
      await page.getByRole('combobox', { name: '界面密度' }).selectOption('compact');
      await expect.poll(() => other.evaluate(() => document.documentElement.dataset.density)).toBe('compact');
      await page.getByRole('combobox', { name: '强调色' }).selectOption('#e05c93');
      await expect.poll(() => other.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe('#e05c93');
      await page.getByRole('radio', { name: '浅色', exact: true }).click();
      await expect.poll(() => other.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
      await section(page, '宠物');
      await page.getByRole('checkbox', { name: '桌面宠物' }).check();
      await page.getByRole('combobox', { name: '形象' }).selectOption('ring');
      await expect(other.locator('.workspace-pet--ring')).toHaveCount(1);
      await page.screenshot({ path: resolve(evidence, `02-pet-sync-${theme}-${width}.png`), fullPage: true });
      await other.reload();
      await expect(other.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
      await other.keyboard.press('Control+,');
      await section(other, '通知');
      await expect(other.getByRole('checkbox', { name: '面板内通知' })).not.toBeChecked();
      await expect(other.getByRole('spinbutton', { name: '保留最近事件条数' })).toHaveValue('23');
      await expect(other.locator('.workspace-pet--ring')).toHaveCount(1);
      await expect.poll(() => other.evaluate(() => document.documentElement.dataset.density)).toBe('compact');
    });
  }
}

test('storage failures retain saved values, display a reason and recover on retry', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+,');
  await section(page, '通知');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Object.assign(window, { restoreSettingsStorage: () => { Storage.prototype.setItem = original; } });
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('watchdog-')) throw new DOMException('quota exceeded', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('checkbox', { name: '面板内通知' }).click();
  await expect(page.getByRole('checkbox', { name: '面板内通知' })).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: '保存失败' })).toBeVisible();
  await page.screenshot({ path: resolve(evidence, '02-notifications-storage-failed.png'), fullPage: true });
  await page.evaluate(() => (window as unknown as { restoreSettingsStorage: () => void }).restoreSettingsStorage());
  await page.getByRole('checkbox', { name: '面板内通知' }).uncheck();
  await expect(page.getByRole('checkbox', { name: '面板内通知' })).not.toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: '保存失败' })).toHaveCount(0);
});

test('clicking an edit menu preserves the selected input for the native copy command', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { selbstlaufDesktop: { shell: { copy: () => {
      const input = document.activeElement as HTMLInputElement;
      Object.assign(window, { settingsCopiedText: input.value?.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0) });
    } } } });
  });
  await page.goto('/');
  await page.keyboard.press('Control+,');
  await section(page, '个人资料');
  const input = page.getByRole('textbox', { name: '显示名称' });
  await input.fill('Selection stays in the profile');
  await input.selectText();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(input).toBeFocused();
  await page.getByRole('menuitem', { name: /^复制/u }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { settingsCopiedText?: string }).settingsCopiedText)).toBe('Selection stays in the profile');
  await page.screenshot({ path: resolve(evidence, '02-profile-edit-focus.png'), fullPage: true });
});
