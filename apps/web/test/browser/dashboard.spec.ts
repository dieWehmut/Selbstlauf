import { expect, test } from '@playwright/test';

test.describe('Selbstlauf watchdog workbench', () => {
  test('renders the desktop process table without horizontal overflow', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    await expect(page.getByText('Selbstlauf')).toBeVisible();
    await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
    await expect(page.locator('.process-table-wrap')).toBeVisible();
    await expect(page.locator('.session-cards')).toBeHidden();
    await expect(page.locator('.process-table tbody tr')).toHaveCount(4);
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
    await expect(page.locator('.session-card')).toHaveCount(4);
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

  test('manages Claude Stop Hook settings in the static Pages demo', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: '设置' }).click();

    const hookSection = page.locator('.hook-settings');
    await expect(hookSection.getByRole('heading', { name: 'Claude Stop Hook' })).toBeVisible();
    await expect(hookSection.getByText('~/.claude/settings.json')).toBeVisible();
    await expect(hookSection.getByRole('checkbox', { name: '启用 Claude Stop Hook' })).not.toBeChecked();
    await hookSection.getByRole('button', { name: '安装 Stop Hook' }).click();
    await expect(hookSection.getByText('需重启 Claude')).toBeVisible();
    await hookSection.getByRole('checkbox', { name: '启用 Claude Stop Hook' }).check();
    await page.getByRole('button', { name: '保存配置' }).click();
    await expect(hookSection.getByText('已启用')).toBeVisible();
    await hookSection.getByRole('button', { name: '停用 Stop Hook' }).click();
    await expect(hookSection.getByText('未启用')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('hook-settings-desktop-1280x900.png'), fullPage: true });
  });

  test('switches Codex endpoints from the settings page', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: '设置' }).click();

    const section = page.locator('.codex-endpoints');
    await expect(section.getByRole('heading', { name: '端点配置' })).toBeVisible();
    await expect(section.getByLabel('接口地址')).toHaveValue('https://external-api-platform.hkgai.net/v1');
    await section.getByRole('button', { name: 'https://www.sevnx.lol' }).click();
    await expect(page.getByRole('status').getByText('Codex 端点已切换')).toBeVisible();
    await expect(section.getByLabel('接口地址')).toHaveValue('https://www.sevnx.lol');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('codex-endpoints-desktop-1280x900.png'), fullPage: true });
  });

  test('reports the local agent environment and the manual install commands', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: '设置' }).click();

    await page.getByRole('tab', { name: '关于' }).click();
    const panel = page.locator('.environment-panel');
    await expect(panel.getByRole('heading', { name: '本地环境检查' })).toBeVisible();

    // Every catalog agent appears with its installed and published version.
    await expect(panel.getByText('Claude Code')).toBeVisible();
    await expect(panel.getByTestId('tool-claude').getByText('2.1.274')).toBeVisible();
    await expect(panel.getByTestId('tool-claude').getByText('2.1.276')).toBeVisible();
    await expect(panel.getByTestId('tool-claude').getByText('可升级')).toBeVisible();

    // A tool that is not installed says so instead of claiming it is current.
    await expect(panel.getByTestId('tool-grok').getByText('未安装').first()).toBeVisible();

    // The manual install block opens and carries the real commands.
    await panel.getByRole('button', { name: /手动安装命令/ }).click();
    await expect(panel.getByTestId('manual-commands')).toContainText('npm i -g @openai/codex@latest');
    await expect(panel.getByTestId('manual-commands')).toContainText('npm i -g openclaw@latest');

    // The Cards stay inside the viewport.
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(1280);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await page.screenshot({ path: testInfo.outputPath('environment-desktop-1280x900.png'), fullPage: true });
  });

  test('keeps the environment cards readable on a narrow mobile viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/');
    await page.getByRole('button', { name: '打开菜单' }).click();
    await page.getByRole('button', { name: '设置' }).click();

    await page.getByRole('tab', { name: '关于' }).click();
    const panel = page.locator('.environment-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('tool-claude')).toBeVisible();
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('environment-mobile-360x780.png'), fullPage: true });
  });


  test('keeps Codex endpoint controls bounded on a narrow mobile viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/');
    await page.getByRole('button', { name: '打开菜单' }).click();
    await page.getByRole('button', { name: '设置' }).click();

    const section = page.locator('.codex-endpoints');
    await expect(section).toBeVisible();
    const sectionBox = await section.boundingBox();
    expect(sectionBox).not.toBeNull();
    expect(sectionBox!.x).toBeGreaterThanOrEqual(0);
    expect(sectionBox!.x + sectionBox!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('codex-endpoints-mobile-360x780.png'), fullPage: true });
  });

  test('keeps Claude Hook controls readable on a narrow mobile viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/');
    await page.getByRole('button', { name: '打开菜单' }).click();
    await page.getByRole('button', { name: '设置' }).click();

    const hookSection = page.locator('.hook-settings');
    await expect(hookSection).toBeVisible();
    await expect(hookSection.getByRole('button', { name: '安装 Stop Hook' })).toBeVisible();
    const sectionBox = await hookSection.boundingBox();
    expect(sectionBox).not.toBeNull();
    expect(sectionBox!.x).toBeGreaterThanOrEqual(0);
    expect(sectionBox!.x + sectionBox!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('hook-settings-mobile-360x780.png'), fullPage: true });
  });
});
