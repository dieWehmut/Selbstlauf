import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { AgentSession } from '../../src/api/agents';

const fixture = resolve('../cli/dist/test/fixtures/agent-terminal.js');

async function launch(page: Page, title: string, tool: 'claude' | 'opencode' = 'claude', args: string[] = [fixture]): Promise<AgentSession> {
  await page.getByRole('button', { name: '启动智能体', exact: true }).click();
  await page.getByLabel('智能体', { exact: true }).selectOption(tool);
  const argumentsField = page.getByLabel('额外启动参数（每行一个）');
  if (!await argumentsField.isVisible()) await page.getByText('启动命令与参数', { exact: true }).click();
  await argumentsField.fill(args.join('\n'));
  await page.getByLabel('启动命令', { exact: true }).fill(process.execPath);
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

test('opens an accepted launch when remembering the selected window fails', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && key === 'selbstlauf-selected-agent') throw new DOMException('quota exceeded', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await page.goto('/');
  let session: AgentSession | undefined;
  try {
    // Capture the accepted process even if the launcher subsequently fails to navigate to it.
    const created = page.waitForResponse((response) => response.url().endsWith('/api/agents') && response.request().method() === 'POST')
      .then(async (response) => { session = await response.json() as AgentSession; });
    await launch(page, '无法记住选择的窗口');
    await created;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('发送到 无法记住选择的窗口 的内容').fill('storage-independent-input');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => output(page, session!.id)).toContain('REPLY storage-independent-input');
    expect(errors).toEqual([]);
  } finally {
    if (session) {
      const headers = { origin: new URL(page.url()).origin };
      await page.request.post(`/api/agents/${session.id}/terminate`, { headers });
      await page.request.delete(`/api/agents/${session.id}`, { headers });
    }
  }
});

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

for (const failure of ['enter', 'payload', 'reconnect', 'edited-draft', 'empty-prefix'] as const) {
  test(`retries a rejected terminal ${failure} without repeating acknowledged input`, async ({ page }) => {
    await page.goto('/');
    const session = await launch(page, `输入重试 ${failure}`, 'opencode', [resolve('../cli/dist/test/fixtures/agent-terminal-protocol.js')]);
    try {
      await expect.poll(() => output(page, session.id)).toContain('QUERY_REPLIED');
      const accepted: string[] = [];
      let rejected = false;
      await page.route(`**/api/agents/${session.id}/input`, async (route) => {
        const data = (route.request().postDataJSON() as { data: string }).data;
        const shouldReject = failure === 'payload' ? accepted.length === 1
          : failure === 'empty-prefix' ? accepted.length === 0 : data === '\r';
        if (!rejected && shouldReject) {
          rejected = true;
          await route.fulfill({ status: 503, json: { error: 'fixture rejected input before accepting it' } });
          return;
        }
        const response = await route.fetch();
        // A reconnect replays startup queries; emulator replies are separate from the user's paste.
        if (response.ok() && !/^\x1b\[\d+;\d+R$/u.test(data)) accepted.push(data);
        await route.fulfill({ response });
      });

      // Place a surrogate pair across the first chunk boundary in the large-paste case.
      const text = failure === 'payload' ? `${'x'.repeat(8185)}🌍${'中文'.repeat(100)}` : '中文第一行\n中文第二行';
      const field = page.getByLabel(`发送到 输入重试 ${failure} 的内容`);
      const send = page.getByRole('button', { name: '发送', exact: true });
      const payload = (value: string) => `\x1b[200~${value.replace(/\n/gu, '\r')}\x1b[201~`;
      await field.fill(text);
      await send.click();
      await expect(page.getByRole('alert')).toHaveText('fixture rejected input before accepting it');
      await expect(field).toHaveValue(text);
      expect(rejected).toBe(true);
      expect(accepted).toHaveLength(failure === 'empty-prefix' ? 0 : 1);
      expect(payload(text).startsWith(accepted.join(''))).toBe(true);
      expect(await output(page, session.id)).not.toContain('SUBMITTED');

      if (failure === 'reconnect') {
        await page.getByRole('button', { name: '重新连接', exact: true }).click();
        await expect(page.getByText('终端已连接', { exact: true })).toBeVisible();
      }
      const edited = '新的独立输入';
      if (failure === 'edited-draft' || failure === 'empty-prefix') await field.fill(edited);
      await send.click();
      await expect(field).toHaveValue('');
      const original = failure === 'empty-prefix' ? '' : `${payload(text)}\r`;
      expect(accepted.join('')).toBe(`${original}${failure === 'edited-draft' || failure === 'empty-prefix' ? `${payload(edited)}\r` : ''}`);
      const pasted = failure === 'empty-prefix' ? edited : text;
      await expect.poll(() => output(page, session.id)).toContain(`PASTE ${JSON.stringify(pasted.replace(/\n/gu, '\r'))}`);
      await expect.poll(async () => (await output(page, session.id)).match(/SUBMITTED/gu)?.length ?? 0)
        .toBe(failure === 'edited-draft' ? 2 : 1);
    } finally {
      await page.request.post(`/api/agents/${session.id}/terminate`, { headers: { origin: new URL(page.url()).origin } });
      await page.request.delete(`/api/agents/${session.id}`, { headers: { origin: new URL(page.url()).origin } });
    }
  });
}

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
