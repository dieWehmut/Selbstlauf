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

  test('shows the window title bar row with working menus at 1280x900', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');

    // The first row is the window's own title bar: 40px, above the page header.
    const titlebar = page.locator('.titlebar');
    await expect(titlebar).toBeVisible();
    const bar = await titlebar.boundingBox();
    expect(bar).not.toBeNull();
    expect(Math.round(bar!.height)).toBe(40);
    expect(Math.round(bar!.y)).toBe(0);
    // It spans the full window width, sidebar included.
    expect(Math.round(bar!.width)).toBe(1280);
    await expect(page.locator('.topbar')).toBeVisible();
    expect(bar!.y + bar!.height).toBeLessThanOrEqual((await page.locator('.topbar').boundingBox())!.y);

    // The four menu buttons are present, in reference order.
    const menus = titlebar.locator('.titlebar__menu-button');
    await expect(menus).toHaveCount(4);
    await expect(menus).toHaveText(['文件', '编辑', '视图', '帮助']);
    // The panel toggle and the history arrows share the row.
    await expect(titlebar.getByRole('button', { name: '收起侧栏' })).toBeVisible();
    await expect(titlebar.getByRole('button', { name: '后退' })).toBeVisible();
    await expect(titlebar.getByRole('button', { name: '前进' })).toBeVisible();

    // Clicking 文件 opens a real dropdown containing 返回应用.
    await titlebar.getByRole('button', { name: '文件' }).click();
    const menu = page.getByRole('menu', { name: '文件' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '返回应用' })).toBeVisible();
    // Escape dismisses it again.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // The row must never introduce a horizontal scrollbar.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await page.screenshot({ path: testInfo.outputPath('titlebar-desktop-1280x900.png'), fullPage: true });
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

  test('shows theme previews and applies a custom accent', async ({ page }, testInfo) => {
    // 1280px is above the 960px drawer breakpoint, so the sidebar is part of the
    // layout and needs no hamburger click (the button is hidden there by design).
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('tab', { name: '通用' }).click();

    // The three previews paint from the live palette, not a static image.
    const previews = page.getByRole('radiogroup', { name: '外观主题' });
    await expect(previews.getByRole('radio', { name: '跟随系统' })).toBeVisible();
    await expect(previews.getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('theme-diff')).toBeVisible();

    // Choosing an accent repaints the app immediately.
    await page.getByRole('combobox', { name: '强调色' }).selectOption({ label: '粉色' });
    const accent = await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));
    expect(accent).toBe('#e05c93');

    // The light scheme keeps the same layout with its own palette.
    await previews.getByRole('radio', { name: '浅色' }).click();
    await page.screenshot({ path: testInfo.outputPath('appearance-light-1280x900.png'), fullPage: true });
    await previews.getByRole('radio', { name: '深色' }).click();

    const panelBox = await page.locator('.appearance-panel').boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(1280);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('appearance-1280x900.png'), fullPage: true });
  });

  test('keeps the appearance previews readable on a narrow mobile viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/');
    await page.getByRole('button', { name: '打开菜单' }).click();
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('tab', { name: '通用' }).click();

    const panel = page.locator('.appearance-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('radiogroup', { name: '外观主题' })).toBeVisible();
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('appearance-mobile-360x780.png'), fullPage: true });
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

  /**
   * Regression: the process table is 930px wide inside an `overflow-x: auto`
   * container, and its header carries an absolutely-positioned `.sr-only`
   * action label. With no positioned ancestor inside that container the label's
   * containing block was `.workspace`, so its 1px box escaped the scroll
   * container and grew the *document* scroll width by exactly the table's right
   * edge. Between 701px and 929px the page therefore scrolled sideways instead
   * of the table scrolling inside its own wrapper.
   */
  test('scrolls the process table inside its wrapper instead of the page', async ({ page }) => {
    for (const width of [701, 760, 900, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `page overflowed at ${width}px`).toBeLessThanOrEqual(1);

      // The table must still be reachable, i.e. the wrapper really scrolls.
      const scrollable = await page.locator('.process-table-wrap').evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
      expect(scrollable.scrollWidth).toBeGreaterThan(scrollable.clientWidth);
    }
  });

  /**
   * Regression: `.icon-button` also sets `display` and is declared after
   * `.mobile-menu`, so it resurrected the drawer's hamburger at every width.
   */
  test('shows the drawer hamburger only inside the drawer breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: '打开菜单' })).toBeHidden();

    await page.setViewportSize({ width: 960, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: '打开菜单' })).toBeVisible();
  });
});
