import { describe, expect, it } from 'vitest';

import { describeShellReason } from '../src/process/shell-reasons';

/**
 * The desktop shell's refusal reasons.
 *
 * The codes here are the ones the shell actually raises: `window-input.ts` rejects an empty, multi-line or
 * over-long line and reports `invalid-window-handle` / `unreadable-response`; `window-preview.ts` reports an
 * unsupported capture; `shell-actions.ts` reports an unwired bridge. Each was printed verbatim in a Chinese
 * panel before this.
 */
describe('describeShellReason', () => {
  it('says what a known shell code means', () => {
    expect(describeShellReason('empty-text')).toBe('没有可写入的内容');
    expect(describeShellReason('windowType needs text to type')).toBe('没有可写入的内容');
    expect(describeShellReason('multi-line-text')).toBe('只能写入一行');
    expect(describeShellReason('text-too-long')).toBe('写入内容过长');
    expect(describeShellReason('invalid-window-handle')).toBe('窗口句柄无效');
    expect(describeShellReason('unreadable-response')).toBe('窗口助手没有返回可读结果');
    expect(describeShellReason('this build cannot capture windows')).toBe('这个版本不能预览窗口');
    expect(describeShellReason('windowPreview is not wired up')).toBe('这个版本不能预览窗口');
    expect(describeShellReason('windowPreview needs a session id')).toBe('缺少会话标识，无法预览窗口');
    expect(describeShellReason('windowType is not wired up')).toBe('这个版本不能写入窗口');
    expect(describeShellReason('windowType needs a session id')).toBe('缺少会话标识，无法写入窗口');
    expect(describeShellReason('that session is no longer running')).toBe('该会话已不在运行');
  });

  it('translates the step in a prefixed reason and keeps the helper message that follows it', () => {
    // The step is the shell's; the message after the colon comes from the helper or the OS, and is the only
    // description of what actually went wrong.
    expect(describeShellReason('could not list sessions: access denied')).toBe('无法读取会话列表：access denied');
    expect(describeShellReason('type-command-failed: no such process')).toBe('写入命令失败：no such process');
  });

  it('passes an unknown reason through unchanged', () => {
    expect(describeShellReason('ERROR_FILE_NOT_FOUND')).toBe('ERROR_FILE_NOT_FOUND');
    // A Chinese reason the shell's own main process raised is already fit to show.
    expect(describeShellReason('该会话没有可写入的窗口')).toBe('该会话没有可写入的窗口');
  });
});