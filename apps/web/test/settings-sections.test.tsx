import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, SessionView } from '../src/api/client';
import {
  PREF_KEYS,
  hashPin,
  isNotificationsPref,
  readPref,
  writePref,
} from '../src/settings/desktop-prefs';
import {
  ACCENT_PRESETS,
  AccountSection,
  BrowserSection,
  ComputerControlSection,
  ImportSection,
  NotificationsSection,
  PetSection,
  PluginsSection,
  ProfileSection,
  ShortcutsSection,
  StartupSection,
  describeTrustedContact,
} from '../src/settings/sections';

beforeEach(() => {
  localStorage.clear();
});

describe('desktop-prefs', () => {
  it('returns the fallback for a missing key', () => {
    expect(readPref(PREF_KEYS.notifications, 'fallback', (value): value is string => typeof value === 'string'))
      .toBe('fallback');
  });

  it('returns the fallback for corrupt JSON', () => {
    localStorage.setItem(PREF_KEYS.notifications, '{ not json');
    expect(readPref(PREF_KEYS.notifications, 'fallback', (value): value is string => typeof value === 'string'))
      .toBe('fallback');
  });

  it('returns the fallback when the stored value fails validation', () => {
    const fallback = { inPanel: true, onSuccess: true, onError: true, timelineLimit: 100 };
    localStorage.setItem(PREF_KEYS.notifications, JSON.stringify({ inPanel: 'yes' }));
    expect(readPref(PREF_KEYS.notifications, fallback, isNotificationsPref)).toEqual(fallback);
  });

  it('round-trips a written value', () => {
    const value = { inPanel: false, onSuccess: true, onError: false, timelineLimit: 25 };
    const fallback = { inPanel: true, onSuccess: true, onError: true, timelineLimit: 100 };
    writePref(PREF_KEYS.notifications, value);
    expect(readPref(PREF_KEYS.notifications, fallback, isNotificationsPref)).toEqual(value);
  });

  it('hashes a PIN deterministically without exposing the plaintext', () => {
    expect(hashPin('1234')).toBe(hashPin('1234'));
    expect(hashPin('1234')).not.toBe(hashPin('1235'));
    expect(hashPin('1234')).not.toContain('1234');
    expect(hashPin('1234')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('NotificationsSection', () => {
  it('persists a toggle across an unmount and remount', () => {
    const first = render(<NotificationsSection />);
    const toggle = screen.getByLabelText('面板内通知');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    first.unmount();

    render(<NotificationsSection />);
    expect(screen.getByLabelText('面板内通知')).not.toBeChecked();
    expect(screen.getByLabelText('操作成功时提示')).toBeChecked();
  });

  it('clamps the retained-event limit and reports it to the caller', () => {
    const onChange = vi.fn();
    render(<NotificationsSection onChange={onChange} />);
    const limit = screen.getByLabelText('保留最近事件条数');
    expect(limit).toHaveValue(100);

    fireEvent.change(limit, { target: { value: '5000' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ timelineLimit: 1000 }));

    fireEvent.change(limit, { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ timelineLimit: 1 }));
  });
});

function stubClipboard(text: string) {
  const readText = vi.fn(async () => text);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText, writeText: vi.fn(async () => undefined) },
  });
  return readText;
}

describe('ImportSection', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('reports the real parser message for non-JSON clipboard content', async () => {
    stubClipboard('this is not json');
    const onImportTheme = vi.fn();
    render(<ImportSection onImportTheme={onImportTheme} onImportConfig={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /导入主题/ }));

    const failure = await screen.findByText(/^导入失败：/);
    expect(failure).toHaveClass('state-chip--error');
    expect(failure.textContent).not.toBe('导入失败：');
    expect(onImportTheme).not.toHaveBeenCalled();
  });

  it('reports success for valid JSON', async () => {
    stubClipboard('{"accent":"#e6b65b"}');
    const onImportTheme = vi.fn();
    render(<ImportSection onImportTheme={onImportTheme} onImportConfig={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /导入主题/ }));

    const success = await screen.findByText('已导入主题');
    expect(success).toHaveClass('state-chip--ready');
    expect(onImportTheme).toHaveBeenCalledWith('{"accent":"#e6b65b"}');
  });

  it('reports an error instead of throwing when the clipboard is unavailable', async () => {
    render(<ImportSection onImportTheme={vi.fn()} onImportConfig={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /导入配置/ }));
    const failure = await screen.findByText(/^导入失败：/);
    expect(failure).toHaveClass('state-chip--error');
  });
});



describe('Section chrome', () => {
  it('uses the shared section frame with a title and hint', () => {
    render(<PluginsSection />);
    const section = document.querySelector('.settings-section');
    expect(section).toHaveClass('settings-section--wide');
    expect(within(section as HTMLElement).getByRole('heading', { level: 2 })).toBeInTheDocument();
    expect(section?.querySelector('.eyebrow')).not.toBeNull();
    expect(section?.querySelector('.section-hint')).not.toBeNull();
  });
});

const sessions: readonly SessionView[] = [
  {
    id: 'writable', tool: 'codex', rootPid: 10, childPids: [], conversationId: null, goal: null,
    transport: 'codex-app-server', alive: true, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2,
  },
  {
    id: 'paused', tool: 'claude', rootPid: 11, childPids: [], conversationId: null, goal: null,
    transport: 'classic-console', alive: true, enabled: true, paused: true, startedAtMs: 1, lastActivityAtMs: 2,
  },
  {
    id: 'dead', tool: 'dsh', rootPid: 12, childPids: [], conversationId: null, goal: null,
    transport: 'dsh-web', alive: false, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2,
  },
  {
    id: 'disabled', tool: 'codex', rootPid: 13, childPids: [], conversationId: null, goal: null,
    transport: 'monitor-only', alive: true, enabled: false, paused: false, startedAtMs: 1, lastActivityAtMs: 2,
  },
];

const events: readonly AuditEvent[] = [
  { id: 'e1', timestampMs: Date.now() - 5 * 60_000, type: 'decision', sessionId: 'writable', details: { decision: 'injected' } },
  { id: 'e2', timestampMs: Date.now() - 60_000, type: 'decision', sessionId: 'writable', details: { decision: 'injected' } },
  { id: 'e3', timestampMs: Date.now() - 30_000, type: 'activity', sessionId: 'paused' },
];

describe('ProfileSection', () => {
  it('offers only the profile field that does something', () => {
    /**
     * 头像 (default/light/dark) and 备注 were written to the preference, validated on read, and shown
     * nowhere: no part of the app rendered an avatar or a note, so both offered a change a person could
     * not observe — the same defect as the notification switches, and the rail's docstring records
     * sections removed for it. The section keeps 显示名称, which the account popup does show; the other
     * two are gone rather than given behaviour invented for them.
     */
    render(<ProfileSection />);

    expect(screen.getByLabelText('显示名称')).toBeInTheDocument();
    expect(screen.queryByLabelText('头像'), 'an avatar control nothing renders').toBeNull();
    expect(screen.queryByLabelText('备注'), 'a note field nothing renders').toBeNull();
  });
});

describe('AccountSection', () => {
  it('links to the real project pages and renders no update strip', () => {
    render(<AccountSection connected running version="1.4.2" />);

    expect(screen.getByText('Selbstlauf').tagName).toBe('STRONG');
    expect(screen.getByText('版本 1.4.2')).toHaveClass('state-chip--ready');

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(3);
    const hrefs = links.map((link) => link.getAttribute('href')).sort();
    expect(hrefs).toEqual([
      'https://github.com/dieWehmut/Selbstlauf',
      'https://github.com/dieWehmut/Selbstlauf',
      'https://github.com/dieWehmut/Selbstlauf/releases',
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer');
    }

    expect(screen.getByRole('link', { name: /官方网站/ })).toHaveAttribute('href', 'https://github.com/dieWehmut/Selbstlauf');
    expect(screen.getByRole('link', { name: /GitHub/ })).toHaveAttribute('href', 'https://github.com/dieWehmut/Selbstlauf');
    expect(screen.getByRole('link', { name: /更新日志/ })).toHaveAttribute('href', 'https://github.com/dieWehmut/Selbstlauf/releases');

    // No fabricated update source: neither a strip nor a check button exists.
    expect(screen.queryByText(/新版本/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /更新/ })).not.toBeInTheDocument();
  });
});

function startupProps(overrides: Partial<Parameters<typeof StartupSection>[0]> = {}) {
  return {
    startupInstalled: false,
    onToggleStartup: vi.fn(),
    busy: false,
    closeToTray: false,
    onCloseToTrayChange: vi.fn(),
    preferredTerminal: 'powershell',
    onPreferredTerminalChange: vi.fn(),
    desktopBridgeAvailable: true,
    ...overrides,
  };
}

describe('ComputerControlSection', () => {
  it('offers only the reveal permission, and reports its change', () => {
    const onAllowRevealChange = vi.fn();
    render(<ComputerControlSection allowReveal onAllowRevealChange={onAllowRevealChange} />);

    const reveal = screen.getByLabelText('允许打开运行位置');
    expect(reveal).toBeChecked();
    fireEvent.click(reveal);
    expect(onAllowRevealChange).toHaveBeenCalledWith(false);
  });

  /**
   * The window's own behaviour belongs to 启动与托盘, not to 电脑操控.
   *
   * Startup, the tray and the terminal used to sit under 电脑操控, which is about what the
   * application may do to the machine — so a person looking for "what happens when I close
   * the window" would not have thought to open it.
   */
  it('keeps startup, tray and terminal out of the computer-control panel', () => {
    render(<ComputerControlSection allowReveal onAllowRevealChange={vi.fn()} />);
    expect(screen.queryByLabelText('开机自启')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('关闭时最小化到托盘')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('首选终端')).not.toBeInTheDocument();
  });
});

describe('StartupSection', () => {
  it('disables the tray row and explains why when the bridge is absent', () => {
    render(<StartupSection {...startupProps({ desktopBridgeAvailable: false })} />);

    expect(screen.getByLabelText('关闭时最小化到托盘')).toBeDisabled();
    expect(screen.getByText('需要桌面应用')).toHaveClass('state-chip--limited');
    expect(screen.getByLabelText('首选终端')).toBeDisabled();
  });

  it('reports tray changes only when available, and reflects the stored value', () => {
    const onCloseToTrayChange = vi.fn();
    render(<StartupSection {...startupProps({ closeToTray: true, onCloseToTrayChange })} />);

    const tray = screen.getByLabelText('关闭时最小化到托盘');
    expect(tray).toBeChecked();
    expect(screen.queryByText('需要桌面应用')).not.toBeInTheDocument();

    fireEvent.click(tray);
    expect(onCloseToTrayChange).toHaveBeenCalledWith(false);
  });

  it('reflects startup state, never optimistically, and is disabled while busy', () => {
    const onToggleStartup = vi.fn();
    const { rerender } = render(<StartupSection {...startupProps({ startupInstalled: false, onToggleStartup })} />);
    const startup = screen.getByLabelText('开机自启');
    expect(startup).not.toBeChecked();

    fireEvent.click(startup);
    expect(onToggleStartup).toHaveBeenCalledTimes(1);
    // Still unchecked: the row only ever reflects the prop.
    expect(startup).not.toBeChecked();

    rerender(<StartupSection {...startupProps({ startupInstalled: false, onToggleStartup, busy: true })} />);
    expect(screen.getByLabelText('开机自启')).toBeDisabled();
  });

  it('reflects the preferred terminal and reports a change', () => {
    const onPreferredTerminalChange = vi.fn();
    render(<StartupSection {...startupProps({ onPreferredTerminalChange })} />);
    expect(screen.getByLabelText('首选终端')).toHaveValue('powershell');

    fireEvent.change(screen.getByLabelText('首选终端'), { target: { value: 'windows-terminal' } });
    expect(onPreferredTerminalChange).toHaveBeenCalledWith('windows-terminal');
  });
});

describe('ShortcutsSection', () => {
  it('lists exactly the honoured shortcuts and nothing more', () => {
    render(<ShortcutsSection />);
    const rows = document.querySelectorAll('.shortcuts-table tbody tr');
    expect(rows).toHaveLength(5);
    expect([...rows].map((row) => row.textContent)).toEqual([
      'Esc关闭侧栏抽屉或已打开的菜单',
      'Ctrl+1切换到进程',
      'Ctrl+2切换到事件',
      'Ctrl+3切换到设置',
      'Ctrl+,切换到设置（与底部菜单上标注的按键一致）',
    ]);
  });

  /**
   * The list's own contract is "exactly the shortcuts the application honours today".
   *
   * That claim was false: the bottom bar's menu displayed Ctrl+, beside 设置 while nothing
   * bound it, so the listed keys and the displayed hint had both drifted from the app.
   * `App.test.tsx` presses every documented page shortcut and requires it to work, which
   * is where the fixture for a full app lives.
   */
});

describe('PetSection', () => {
  it('reports the switch and the form to the caller', () => {
    const onChange = vi.fn();
    render(<PetSection pet={{ enabled: false, form: 'dot' }} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('桌面宠物'));
    expect(onChange).toHaveBeenCalledWith({ enabled: true, form: 'dot' });

    fireEvent.change(screen.getByLabelText('形象'), { target: { value: 'ring' } });
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false, form: 'ring' });
  });

  it('leaves the ornament to the app, which shows it on every page', () => {
    // The section used to draw it, so it existed only while this section was open — see the app-level
    // tests for where it is meant to be.
    render(<PetSection pet={{ enabled: true, form: 'ring' }} onChange={() => undefined} />);
    expect(document.querySelector('.workspace-pet'), 'the section drew the ornament itself').toBeNull();
  });
});

describe('PluginsSection', () => {
  it('rejects empty entries, adds and removes prompts, and joins them', async () => {
    render(<PluginsSection />);
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getByText('提示词不能为空')).toBeInTheDocument();

    const input = screen.getByLabelText('手动续写提示词');
    fireEvent.change(input, { target: { value: '请继续' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(input, { target: { value: '保持简洁' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(screen.getByTestId('plugins-effective')).toHaveTextContent('合并后的提示词：请继续 保持简洁');
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(PREF_KEYS.plugins) ?? 'null')).toEqual({ prompts: ['请继续', '保持简洁'] });
    });

    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[0]);
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(PREF_KEYS.plugins) ?? 'null')).toEqual({ prompts: ['保持简洁'] });
    });
  });
});

describe('BrowserSection', () => {
  it('names the current theme the way the rest of the interface does', () => {
    /**
     * 当前主题 printed the raw identifier — `dark`, `light` — in a panel that is otherwise entirely Chinese
     * and whose sibling rows read 访问地址 / 在浏览器中打开. The appearance section calls the same two things
     * 深色 and 浅色, and this is the same defect as the decision chip that showed the English word
     * "disabled" beside every session.
     */
    render(<BrowserSection theme="dark" origin="http://127.0.0.1:4174" />);

    expect(screen.getByText('http://127.0.0.1:4174')).toBeInTheDocument();
    expect(screen.getByText('深色')).toBeInTheDocument();
    expect(screen.queryByText('dark'), 'a raw theme identifier in a Chinese panel').toBeNull();
  });

  it('names the light theme too, and opens the origin in a new tab', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<BrowserSection theme="light" origin="http://127.0.0.1:4174" />);

    expect(screen.getByText('浅色')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /在浏览器中打开/ }));
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:4174', '_blank', 'noreferrer');
    vi.unstubAllGlobals();
  });

  it('disables the button when there is no origin to open', () => {
    render(<BrowserSection theme="light" origin="" />);
    expect(screen.getByRole('button', { name: /在浏览器中打开/ })).toBeDisabled();
  });
});