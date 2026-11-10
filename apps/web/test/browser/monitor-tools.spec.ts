import { expect, test } from '@playwright/test';
import { createStaticDemoApi } from '../../src/api/static-demo';
import type { SessionView } from '../../src/api/client';

test('new tools show publisher icons, parsed output and monitoring capabilities across Windows and WSL', async ({ page }, testInfo) => {
  const demo = createStaticDemoApi();
  const [template] = await demo.sessions();
  const tools = ['gemini', 'antigravity', 'cursor'] as const;
  const sources = ['gemini-jsonl', 'antigravity-projection', 'cursor-agent-host'];
  const sessions: SessionView[] = tools.map((tool, index) => ({ ...template!, id: `${tool}:monitor`, tool,
    rootPid: 80 + index, childPids: [], conversationId: `conversation-${tool}`, conversationTitle: `${tool} conversation`,
    transport: 'monitor-only', goal: null, pendingPrompt: null,
    transportError: 'This session supports monitoring; no verified input transport is available',
    runningTurn: undefined, quietForMs: 3_600_000, lastDecision: 'monitoring',
    distribution: tool === 'gemini' ? 'Ubuntu' : undefined, platform: tool === 'gemini' ? 'linux' : 'windows',
    sessionCwd: tool === 'gemini' ? '/home/han/gemini-project' : `C:/work/${tool}`,
    host: tool === 'gemini' ? template!.host : { processId: 80 + index, executableName: `${tool}.exe`,
      label: tool === 'cursor' ? 'Cursor' : 'Antigravity', category: 'editor', windowHandle: 90 + index, windowTitle: `${tool} project` },
  }));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    const outputMatch = /^\/api\/sessions\/([^/]+)\/output$/u.exec(path);
    if (outputMatch) {
      const id = decodeURIComponent(outputMatch[1]!);
      const index = sessions.findIndex((session) => session.id === id);
      return respond({ sessionId: id, state: index === 2 ? 'unavailable' : 'ready', source: sources[index], truncated: false,
        ...(index === 2 ? { reason: 'host-transcript-unavailable' } : {}),
        entries: index === 2 ? [] : [{ id: 'reply-1', role: 'assistant', text: `Parsed ${tools[index]} reply`, timestampMs: 42 }] });
    }
    switch (path) {
      case '/api/health': return respond(await demo.health());
      case '/api/config': return respond(await demo.config());
      case '/api/sessions': return respond({ sessions });
      case '/api/startup': return respond(await demo.startup());
      case '/api/claude-hook': return respond(await demo.claudeHook());
      case '/api/codex/profiles': return respond(await demo.codexProfiles());
      case '/api/environment': return respond(await demo.environment());
      case '/api/events': return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
      default: return route.fulfill({ status: 204, body: '' });
    }
  });
  await page.setViewportSize({ width: 1249, height: 850 });
  await page.goto('/');
  await expect(page.locator('.sidebar-row')).toHaveCount(3);
  await expect(page.locator('.sidebar-processes__heading', { hasText: 'Windows' })).toBeVisible();
  await expect(page.locator('.sidebar-processes__heading', { hasText: 'WSL · Ubuntu' })).toBeVisible();
  for (const tool of tools) {
    const row = page.locator(`[data-session-id="${tool}:monitor"]`);
    await expect(row).toContainText('状态未知');
    const icon = row.locator('.tool-icon__image');
    await expect(icon).toHaveAttribute('src', new RegExp(`tool-icons/${tool}\\.(svg|png)$`, 'u'));
    await expect.poll(() => icon.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(icon).toHaveAttribute('alt', '');
  }
  await page.screenshot({ path: testInfo.outputPath('monitor-tool-icons.png') });
  for (const [index, tool] of tools.entries()) {
    await page.locator(`[data-session-id="${tool}:monitor"] .sidebar-row__open`).click();
    await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();
    await expect(page.getByText(index === 2 ? '本机未导出可读取的会话正文，暂仅显示会话状态。' : `Parsed ${tool} reply`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `立即续写 PID ${80 + index}`, exact: true }).first()).toBeDisabled();
    await expect(page.getByText('仅监控', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('监控中', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('该会话仅支持监控，尚无可验证的输入通道。', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('空闲', { exact: true })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
