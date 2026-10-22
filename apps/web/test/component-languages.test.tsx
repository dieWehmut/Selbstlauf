import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionView } from '../src/api/client';
import { applyLocale, LOCALES, type Locale } from '../src/i18n';
import { FormattedMessage } from '../src/i18n/FormattedMessage';
import { componentError } from '../src/i18n/component-errors';
import { SettingsRail } from '../src/settings/SettingsRail';
import { ImportSection, NotificationsSection, relativeAge } from '../src/settings/sections';
import { SessionOutputPanel } from '../src/process/SessionOutputPanel';
import { noWindowReason } from '../src/process/SessionWindowPreview';
import { promptProblem } from '../src/process/SessionPromptComposer';
import { describeShellReason } from '../src/process/shell-reasons';
import { conversationLabel, groupSessionsByHost } from '../src/sidebar/session-groups';
import { writeEligibility } from '../src/session/write-eligibility';
import { describeAuditDetails } from '../src/timeline/audit-details';

function session(overrides: Partial<SessionView> = {}): SessionView {
  return { id: 'codex:42', tool: 'codex', rootPid: 42, childPids: [], conversationId: null,
    goal: null, transport: 'codex-app-server', alive: true, enabled: true, paused: false,
    startedAtMs: 0, lastActivityAtMs: null, quietForMs: 0, host: null, ...overrides };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('component language switching', () => {
  it.each([
    ['zh-CN', '搜索设置', '通知', '面板内通知', '托盘'],
    ['zh-TW', '搜尋設定', '通知', '面板內通知', '系統匣'],
    ['en', 'Search settings', 'Notifications', 'Panel notifications', 'tray'],
    ['ja', '設定を検索', '通知', 'パネル内の通知', 'トレイ'],
  ] as const)('renders labels, accessible names and translated search in %s', (locale, search, tab, notification, query) => {
    applyLocale(locale);
    render(<><SettingsRail active="general" onSelect={() => undefined} onBack={() => undefined} /><NotificationsSection /></>);
    expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: notification })).toBeChecked();
    fireEvent.change(screen.getByRole('searchbox', { name: search }), { target: { value: query } });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab')).toHaveAttribute('data-section', 'startup');
    expect(screen.getByRole('tab')).toHaveAttribute('tabindex', '0');
  });

  it('translates an existing import result without repeating the import or losing the draft', async () => {
    const importConfig = vi.fn();
    render(<ImportSection onImportTheme={() => undefined} onImportConfig={importConfig} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'JSON 文本' }), { target: { value: '{"name":"用户数据"}' } });
    fireEvent.click(screen.getByRole('button', { name: '导入文本' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已导入配置');
    act(() => applyLocale('en'));
    expect(screen.getByRole('status')).toHaveTextContent('Configuration imported');
    expect(screen.getByRole('textbox', { name: 'JSON text' })).toHaveValue('{"name":"用户数据"}');
    expect(importConfig).toHaveBeenCalledTimes(1);
  });

  it('translates a stored preference error and allows retry after storage becomes available', () => {
    render(<NotificationsSection />);
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota'); });
    fireEvent.click(screen.getByRole('checkbox', { name: '面板内通知' }));
    save.mockRestore();
    act(() => applyLocale('ja'));
    expect(screen.getByRole('status')).toHaveTextContent('ブラウザーの保存領域');
    fireEvent.click(screen.getByRole('checkbox', { name: 'パネル内の通知' }));
    expect(screen.getByRole('checkbox', { name: 'パネル内の通知' })).not.toBeChecked();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps real process output intact and changes role labels without fetching again', async () => {
    const output = vi.fn().mockResolvedValue({ sessionId: 'codex:42', state: 'ready', source: 'codex-rollout', truncated: false,
      entries: [{ id: 'output', role: 'assistant', text: '<b>用户输入：继续</b>', timestampMs: null }] });
    render(<SessionOutputPanel sessionId="codex:42" requestOutput={output} />);
    expect(await screen.findByText('<b>用户输入：继续</b>')).toBeInTheDocument();
    act(() => applyLocale('en'));
    expect(screen.getByRole('region', { name: 'Session output' })).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('<b>用户输入：继续</b>')).toBeInTheDocument();
    expect(document.querySelector('.session-output pre b')).toBeNull();
    expect(output).toHaveBeenCalledTimes(1);
  });

  it('inserts safe React nodes in translated whole sentences and never parses HTML', () => {
    render(<p><FormattedMessage source="已发送：{text}" params={{ text: <code>{'<img src=x onerror=alert(1)> 用户数据'}</code> }} /></p>);
    act(() => applyLocale('ja'));
    expect(screen.getByText(/送信しました/u)).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)> 用户数据').tagName).toBe('CODE');
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('pure helper locale arguments', () => {
  it.each(LOCALES)('changes labels without changing session eligibility or identifiers in %s', (locale: Locale) => {
    const value = session({ paused: true, distribution: 'Ubuntu-用户' });
    expect(writeEligibility(value, locale).writable).toBe(false);
    expect(noWindowReason(value, locale)).toContain('Ubuntu-用户');
    expect(promptProblem('x'.repeat(4097), locale)).toContain('4097');
    expect(relativeAge(0, 120_000, locale)).toContain('2');
    const grouped = groupSessionsByHost([value], [value.id], locale);
    expect(grouped[0].sessions[0]).toBe(value);
    if (locale === 'en') {
      expect(grouped[0].label).toBe('Pinned');
      expect(conversationLabel(session({ goal: { status: 'active', updatedAtMs: 0 } }), locale)).toBe('Goal · Active');
      expect(describeShellReason('type-command-failed: OS 错误', locale)).toBe('The typing command failed: OS 错误');
    }
  });

  it('translates timeline keys, actions and booleans while retaining external values', () => {
    const result = describeAuditDetails({ action: 'startup-install', ok: false, custom: '用户数据' },
      { time: String, decision: String, reason: String, tool: String }, 'en');
    expect(result).toBe('Action: Enable startup · Result: Failure · custom: 用户数据');
    expect(componentError('智能体服务请求失败（503）', 'en')).toBe('Agent service request failed (503)');
    expect(componentError('OS 外部诊断', 'ja')).toBe('OS 外部诊断');
  });
});
