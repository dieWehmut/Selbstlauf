import { expect, test } from '@playwright/test';
import type { AgentCatalog } from '../../src/api/agents';

test('the live catalog renders every AgentRouter product with an official icon and usable guides', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const catalog = await (await page.request.get('/api/agents/catalog')).json() as AgentCatalog;
  const expected = ['claude', 'codex', 'gemini', 'qwen', 'opencode', 'openclaw', 'hermes', 'pi', 'crush',
    'cline', 'roo', 'kilo', 'claude-app', 'trae', 'zcode', 'workbuddy', 'craft-agents'];
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
