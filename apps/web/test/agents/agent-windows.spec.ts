import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { AgentSession } from '../../src/api/agents';

const fixture = resolve('../cli/dist/test/fixtures/agent-terminal.js');

async function launch(page: Page, title: string, tool: 'claude' | 'opencode' = 'claude', args: string[] = [fixture]): Promise<AgentSession> {
  await page.getByRole('button', { name: '启动智能体', exact: true }).click();
  await page.getByLabel('智能体', { exact: true }).selectOption(tool);
  await page.getByText('启动命令与参数', { exact: true }).click();
  await page.getByLabel('启动命令', { exact: true }).fill(process.execPath);
  await page.getByLabel('额外启动参数（每行一个）').fill(args.join('\n'));
  await page.getByLabel('窗口名称（可选）').fill(title);
  const result = page.waitForResponse((response) => response.url().endsWith('/api/agents') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '启动', exact: true }).click();
  const response = await result;
  expect(response.status()).toBe(201);
  const session = await response.json() as AgentSession;
  await expect(page.getByRole('tab', { name: title, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel').getByText('终端已连接', { exact: true })).toBeVisible();
  return session;
}

async function output(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`/api/agents/${id}/output`);
  return (await response.json()).data;
}

test('real windows deliver Unicode, multiline and keyboard input, retain drafts, replay after reload and open an independent page', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const sessions: AgentSession[] = [];
  try {
    const first = await launch(page, 'Claude 进程窗口'); sessions.push(first);
    await page.getByLabel('发送到 Claude 进程窗口 的内容').fill('中文第一行\n中文第二行');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => output(page, first.id)).toContain('REPLY 中文第二行');
    await page.getByLabel('Claude 进程窗口 终端输入', { exact: true }).focus();
    await page.keyboard.type('keyboard-first');
    await page.keyboard.press('Enter');
    await expect.poll(() => output(page, first.id)).toContain('REPLY keyboard-first');
    await page.getByLabel('发送到 Claude 进程窗口 的内容').fill('第一窗口的草稿');
    const second = await launch(page, 'OpenCode 进程窗口', 'opencode'); sessions.push(second);
    await page.getByLabel('发送到 OpenCode 进程窗口 的内容').fill('second-window');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => output(page, second.id)).toContain('REPLY second-window');
    expect(await output(page, first.id)).not.toContain('second-window');
    await page.getByRole('tab', { name: 'Claude 进程窗口', exact: true }).click();
    await expect(page.getByLabel('发送到 Claude 进程窗口 的内容')).toHaveValue('第一窗口的草稿');
    await page.reload();
    await expect(page.getByRole('heading', { name: '智能体窗口', exact: true })).toBeVisible();
    await expect(page.getByLabel('发送到 Claude 进程窗口 的内容')).toHaveValue('第一窗口的草稿');
    await expect(page.getByRole('tabpanel').locator('.xterm-accessibility-tree')).toContainText('REPLY keyboard-first');
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: '独立窗口', exact: true }).click();
    const popup = await opened;
    await expect(popup.getByRole('tabpanel').getByText('终端已连接', { exact: true })).toBeVisible();
    await popup.getByLabel('发送到 Claude 进程窗口 的内容').fill('popup-first');
    await popup.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => output(page, first.id)).toContain('REPLY popup-first');
    await popup.close();
    await page.getByRole('button', { name: '结束进程', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText('已结束');
    await expect(page.getByLabel('发送到 Claude 进程窗口 的内容')).toBeDisabled();
    expect(await output(page, first.id)).toContain('REPLY popup-first');
    expect(errors).toEqual([]);
  } finally {
    for (const session of sessions) {
      await page.request.post(`/api/agents/${session.id}/terminate`, { headers: { origin: new URL(page.url()).origin } });
      await page.request.delete(`/api/agents/${session.id}`, { headers: { origin: new URL(page.url()).origin } });
    }
  }
});

test('answers real TUI startup queries and sends multiline prompts using bracketed paste and Ctrl+C', async ({ page }) => {
  await page.goto('/');
  const session = await launch(page, '交互式协议窗口', 'opencode', [resolve('../cli/dist/test/fixtures/agent-terminal-protocol.js')]);
  try {
    await expect.poll(() => output(page, session.id)).toContain('QUERY_REPLIED');
    await page.getByLabel('发送到 交互式协议窗口 的内容').fill('中文第一行\n中文第二行');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => output(page, session.id)).toContain('PASTE "中文第一行\\r中文第二行"');
    await expect.poll(() => output(page, session.id)).toContain('SUBMITTED');
    await page.getByLabel('交互式协议窗口 终端输入', { exact: true }).focus();
    await page.keyboard.press('Control+c');
    await expect.poll(() => output(page, session.id)).toContain('INTERRUPTED');
  } finally {
    await page.request.post(`/api/agents/${session.id}/terminate`, { headers: { origin: new URL(page.url()).origin } });
    await page.request.delete(`/api/agents/${session.id}`, { headers: { origin: new URL(page.url()).origin } });
  }
});

test('the monitored detail page writes to a real PTY and then displays that process\'s recorded response', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情', exact: true })).toBeVisible();
  await expect(page.getByText('受控终端已就绪（真实 TTY）。', { exact: true })).toBeVisible();
  const prompt = `详情页中文输入 ${testInfo.project.name}`;
  await page.getByLabel('要发送到该会话的文字').fill(prompt);
  const submitted = page.waitForResponse((response) => response.url().includes('/api/sessions/') && response.url().endsWith('/inject'));
  await page.locator('.prompt-composer').getByRole('button', { name: /发送到 PID/u }).click();
  const result = await submitted;
  expect(result.status()).toBe(200);
  expect((await result.json()).dryRun).toBe(false);
  await expect(page.getByText(`实际回复：${prompt}`, { exact: true })).toBeVisible({ timeout: 10000 });
  await page.reload();
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByText(`实际回复：${prompt}`, { exact: true })).toBeVisible();
});
