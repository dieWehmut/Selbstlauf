import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_LOCALES, isDesktopLocale, nativeMessage } from '../src/locale.js';
import { resolveTerminalCommand, openSessionTerminal } from '../src/terminal.js';
import { captureSessionWindow } from '../src/window-preview.js';
import { typingRefusal } from '../src/window-input.js';

test('only the four supported native locales are accepted', () => {
  for (const locale of DESKTOP_LOCALES) assert.equal(isDesktopLocale(locale), true);
  for (const locale of ['fr', 'en-US', 'ZH-CN', '', null, 1, {}, ['ja']]) assert.equal(isDesktopLocale(locale), false);
});

for (const [locale, closed, missingTerminal, shared] of [
  ['zh-CN', '该会话已不在运行。', '未找到终端', '个受监控会话'],
  ['zh-TW', '該工作階段已停止執行。', '找不到終端機', '個受監控工作階段'],
  ['en', 'That session is no longer running.', 'was not found', 'monitored sessions'],
  ['ja', 'このセッションは終了しています。', 'が見つかりません', '監視中のセッション'],
] as const) {
  test(`${locale} gives translated terminal, capture and shared-window failures with actual details`, async () => {
    const outcome = await openSessionTerminal('gone', { locale, sessions: async () => [], preference: async () => null });
    assert.deepEqual(outcome, { ok: false, reason: closed });
    assert.deepEqual(await captureSessionWindow({ locale, sessions: async () => [], getSources: async () => [] }, 'gone'), { state: 'unsupported', reason: closed });
    await assert.rejects(resolveTerminalCommand({ id: 'session', cwd: '/tmp' }, 'xterm', { locale, platform: 'linux', env: { DISPLAY: ':0' }, findExecutable: async () => null }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(missingTerminal));
      assert.ok(error.message.includes('xterm'));
      return true;
    });
    const refusal = typingRefusal(3, locale);
    assert.ok(refusal?.includes(shared));
    assert.ok(refusal?.includes('3'));
    assert.equal(typingRefusal(1, locale), null);
    const error = nativeMessage(locale, 'sessionsReadFailed', { detail: 503 });
    assert.ok(error.includes('503'));
    assert.equal(error.includes('{detail}'), false);
  });
}
