import { describe, expect, it } from 'vitest';

import { describeAuditDetails } from '../src/timeline/audit-details';

/**
 * The two vocabularies that have their own owners are passed in, so these tests use stand-ins and assert that
 * they are *called* rather than that they are reimplemented here.
 */
const labels = {
  time: (timestampMs: number) => `T${timestampMs}`,
  decision: (decision: string) => (decision === 'awaiting-quiet-period' ? '等待静默' : `未知状态(${decision})`),
  reason: (reason: string) => (reason === 'no-cwd-match' ? '未找到同目录 Codex 线程' : reason),
  tool: (tool: string) => (tool === 'dsh' ? 'DeepSeek Harness' : tool),
};

describe('describeAuditDetails', () => {
  it('names a field instead of printing a bare value', () => {
    expect(describeAuditDetails({ decision: 'awaiting-quiet-period' }, labels)).toBe('决策：等待静默');
  });

  it('translates the vocabularies it owns', () => {
    expect(describeAuditDetails({ action: 'manual-inject' }, labels)).toBe('操作：手动续写');
    expect(describeAuditDetails({ action: 'claude-hook-disable' }, labels)).toBe('操作：停用 Stop Hook');
    expect(describeAuditDetails({ source: 'dsh-session' }, labels)).toBe('来源：Harness 会话');
    expect(describeAuditDetails({ dryRun: true }, labels)).toBe('Dry Run：是');
    expect(describeAuditDetails({ restartRequired: false }, labels)).toBe('需重启：否');
    // `ok` is a verdict, not a flag.
    expect(describeAuditDetails({ ok: false }, labels)).toBe('结果：失败');
    expect(describeAuditDetails({ succeeded: 3 }, labels)).toBe('成功数：3');
  });

  it('delegates the decisions, reasons and tools that already have owners', () => {
    expect(describeAuditDetails({ reason: 'no-cwd-match' }, labels)).toBe('原因：未找到同目录 Codex 线程');
    expect(describeAuditDetails({ decision: 'cooldown' }, labels)).toBe('决策：未知状态(cooldown)');
    // The tool names come from the same owner the sidebar and the process table use.
    expect(describeAuditDetails({ tool: 'dsh' }, labels)).toBe('工具：DeepSeek Harness');
    expect(describeAuditDetails({ tool: 'opencode' }, labels)).toBe('工具：opencode');
  });

  it('renders a timestamp as a time rather than an epoch number', () => {
    expect(describeAuditDetails({ decision: 'new', atMs: 1_789_000_000_000 }, labels))
      .toBe('决策：未知状态(new) · 时间：T1789000000000');
  });

  it('keeps a field it does not know, under its own name', () => {
    // A payload this build has never seen stays legible instead of disappearing.
    expect(describeAuditDetails({ 'wsl-distro': 'Ubuntu', attempts: 2 }, labels))
      .toBe('wsl-distro：Ubuntu · attempts：2');
  });

  it('says nothing about a field whose value is null', () => {
    // The engine writes null for "no reason"; 原因：null would be words spent on an absence.
    expect(describeAuditDetails({ action: 'focus', reason: null }, labels)).toBe('操作：打开运行位置');
  });

  it('renders an absent or empty payload as nothing at all', () => {
    expect(describeAuditDetails(undefined, labels)).toBe('');
    expect(describeAuditDetails({}, labels)).toBe('');
  });

  it('keeps a free-form diagnostic reason as the engine wrote it', () => {
    // Prefixed reasons carry the failing step and the underlying message; translating the tail would leave a
    // half-English line, so the whole string is passed through.
    expect(describeAuditDetails({ reason: 'process-discovery: Access denied' }, labels))
      .toBe('原因：process-discovery: Access denied');
  });
});