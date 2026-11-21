import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import type { AgentCatalog, AgentSession } from '../../src/api/agents';
import { EnvironmentCheck } from '../../../cli/src/environment/environment-check';

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
  // This checks navigation to an install action. Version probes can wait on an offline registry.
  const environment = await new EnvironmentCheck({
    readInstalled: async () => [],
    readLatest: async () => new Map(),
  }).report();
  await page.route('**/api/environment', (route) => route.fulfill({ json: environment }));
  await page.goto('/');
  await page.getByRole('button', { name: '启动智能体', exact: true }).click();
  await page.getByLabel('智能体', { exact: true }).selectOption(missing!.id);
  await page.getByRole('button', { name: '打开环境设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.environment-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: `安装 ${missing!.label}`, exact: true })).toBeEnabled({ timeout: 20000 });
});

for (const width of [1280, 390]) {
  test(`typing a missing CLI path keeps launch options visible at ${width}px`, async ({ page }) => {
    const catalog = await (await page.request.get('/api/agents/catalog')).json() as AgentCatalog;
    await page.route('**/api/agents/catalog', (route) => route.fulfill({ json: {
      ...catalog,
      tools: catalog.tools.map((entry) => entry.id === 'opencode'
        ? { ...entry, available: false, command: null, installation: { status: 'not-found' } }
        : entry),
    } }));
    await page.setViewportSize({ width, height: 900 });
    let launched: AgentSession | undefined;
    try {
      await page.goto('/');
      await page.getByRole('button', { name: '启动智能体', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('智能体', { exact: true }).selectOption('opencode');
      const command = dialog.getByLabel('启动命令', { exact: true });
      const args = dialog.getByLabel('额外启动参数（每行一个）');
      await expect(command).toBeVisible();
      await command.pressSequentially(process.execPath.slice(0, 1));
      await expect(command).toBeVisible();
      await expect(command).toBeFocused();
      await command.pressSequentially(process.execPath.slice(1));
      await expect(args).toBeVisible();
      const fixture = resolve('../cli/dist/test/fixtures/agent-terminal.js');
      await args.fill(`${fixture}\nargument with spaces\n中文`);
      await dialog.getByLabel('窗口名称（可选）').fill(`路径输入 ${width}`);

      const response = page.waitForResponse((result) => result.url().endsWith('/api/agents') && result.request().method() === 'POST');
      await dialog.getByRole('button', { name: '启动', exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(201);
      launched = await result.json() as AgentSession;
      expect(launched.command).toBe(process.execPath);
      expect(launched.args).toEqual([fixture, 'argument with spaces', '中文']);
      await expect.poll(async () => (await (await page.request.get(`/api/agents/${launched!.id}/output`)).json()).data)
        .toContain('"args":["argument with spaces","中文"]');
    } finally {
      if (launched) {
        const headers = { origin: new URL(page.url()).origin };
        await page.request.post(`/api/agents/${launched.id}/terminate`, { headers });
        await page.request.delete(`/api/agents/${launched.id}`, { headers });
      }
    }
  });
}
