import { expect, test } from '@playwright/test';
import type { AgentCatalog } from '../../src/api/agents';

test('the live catalog renders every AgentRouter product with an official icon and usable guides', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const catalog = await (await page.request.get('/api/agents/catalog')).json() as AgentCatalog;
  const expected = ['claude', 'codex', 'gemini', 'qwen', 'opencode', 'openclaw', 'hermes', 'pi', 'crush',
    'cline', 'roo', 'kilo', 'claude-app', 'trae', 'zcode', 'workbuddy', 'workbuddy-intl', 'craft-agents'];
  expect(catalog.tools.map((tool) => tool.id)).toEqual(expect.arrayContaining(expected));
  await page.goto('/');
  await page.getByRole('button', { name: '启动智能体', exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (const tool of catalog.tools.filter((entry) => !['shell', 'custom'].includes(entry.id))) {
    await dialog.getByLabel('智能体', { exact: true }).selectOption(tool.id);
    await expect(dialog.locator('.agent-launcher__tool strong')).toHaveText(tool.label);
    const icon = dialog.locator('.agent-launcher__tool img:visible');
    await expect(icon).toBeVisible();
    await expect.poll(() => icon.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect(dialog.getByRole('link', { name: '官方安装', exact: true })).toHaveAttribute('href', tool.installUrl!);
    if (tool.id === 'workbuddy' || tool.id === 'workbuddy-intl') {
      const international = tool.id === 'workbuddy-intl';
      const website = international ? 'https://www.workbuddy.ai/' : 'https://www.workbuddy.cn/';
      await expect(dialog.locator('.agent-launcher__tool strong')).toHaveText(international ? 'WorkBuddy 国际版' : 'WorkBuddy 国内版');
      await expect(dialog.getByRole('link', { name: '官方安装', exact: true })).toHaveAttribute('href', website);
      await expect(dialog.getByRole('link', { name: '官方文档', exact: true })).toHaveAttribute('href', `${website}docs/workbuddy/`);
      await expect(icon).toHaveAttribute('src', /\/tool-icons\/workbuddy\.svg$/u);
    }
    for (const url of tool.guideUrls ?? []) {
      await expect(dialog.locator(`a[href="${url}"]`)).toBeVisible();
    }
    if (tool.kind === 'desktop' || tool.kind === 'extension') {
      await expect(dialog.getByRole('button', { name: '启动', exact: true })).toHaveCount(0);
      await expect(dialog.getByLabel('工作目录', { exact: true })).toHaveCount(0);
    } else {
      await expect(dialog.getByLabel('工作目录', { exact: true })).toBeVisible();
      if (!tool.available) await expect(dialog.getByRole('button', { name: '启动', exact: true })).toBeDisabled();
    }
  }
  expect(errors).toEqual([]);
});

test('a missing CLI opens the actual installation panel', async ({ page }) => {
  const catalog = await (await page.request.get('/api/agents/catalog')).json() as AgentCatalog;
  const missing = catalog.tools.find((tool) => tool.kind === 'cli' && !tool.available && tool.installCommand?.startsWith('npm '));
  test.skip(!missing, 'Every npm CLI is installed on this host.');
  await page.goto('/');
  await page.getByRole('button', { name: '启动智能体', exact: true }).click();
  await page.getByLabel('智能体', { exact: true }).selectOption(missing!.id);
  await page.getByRole('button', { name: '打开环境设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.environment-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: `安装 ${missing!.label}`, exact: true })).toBeEnabled({ timeout: 20000 });
});
