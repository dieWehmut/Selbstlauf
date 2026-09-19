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
  ParentalSection,
  PersonalizationSection,
  PetSection,
  PluginsSection,
  ShortcutsSection,
  SnapshotsSection,
  TrustedContactSection,
  UsageSection,
  VoiceSection,
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
    expect(screen.getByLabelText('续写成功时提示')).toBeChecked();
  });

  it('clamps the retained-event limit and reports it to the caller', () => {
    const onTimelineLimitChange = vi.fn();
    render(<NotificationsSection onTimelineLimitChange={onTimelineLimitChange} />);
    const limit = screen.getByLabelText('保留最近事件条数');
    expect(limit).toHaveValue(100);

    fireEvent.change(limit, { target: { value: '5000' } });
    expect(onTimelineLimitChange).toHaveBeenLastCalledWith(1000);

    fireEvent.change(limit, { target: { value: '0' } });
    expect(onTimelineLimitChange).toHaveBeenLastCalledWith(1);
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

function typePin(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function storedParental() {
  return JSON.parse(localStorage.getItem(PREF_KEYS.parental) ?? 'null') as unknown;
}

describe('ParentalSection', () => {
  it('refuses to enable when the PINs do not match', () => {
    const onLockChange = vi.fn();
    render(<ParentalSection locked={false} onLockChange={onLockChange} />);
    typePin('PIN', '1234');
    typePin('确认 PIN', '4321');

    fireEvent.click(screen.getByLabelText('家长控制'));

    expect(screen.getByText('两次输入的 PIN 不一致')).toBeInTheDocument();
    expect(screen.getByLabelText('家长控制')).not.toBeChecked();
    expect(onLockChange).not.toHaveBeenCalled();
    expect(storedParental()).toBeNull();
  });

  it('refuses to enable a too-short PIN', () => {
    render(<ParentalSection locked={false} onLockChange={vi.fn()} />);
    typePin('PIN', '12');
    typePin('确认 PIN', '12');

    fireEvent.click(screen.getByLabelText('家长控制'));

    expect(screen.getByText('PIN 需要 4 到 8 位数字')).toBeInTheDocument();
    expect(screen.getByLabelText('家长控制')).not.toBeChecked();
  });

  it('enables on a valid pair, reports the lock, and stores no plaintext PIN', () => {
    const onLockChange = vi.fn();
    render(<ParentalSection locked={false} onLockChange={onLockChange} />);
    typePin('PIN', '482913');
    typePin('确认 PIN', '482913');

    fireEvent.click(screen.getByLabelText('家长控制'));

    expect(onLockChange).toHaveBeenCalledWith(true);
    expect(screen.getByLabelText('家长控制')).toBeChecked();
    const stored = storedParental() as { enabled: boolean; pinHash: string; allowlist: string[] };
    expect(stored.enabled).toBe(true);
    expect(stored.pinHash).toBe(hashPin('482913'));
    expect(JSON.stringify(stored)).not.toContain('482913');
  });

  it('requires the correct PIN to disable', () => {
    const onLockChange = vi.fn();
    writePref(PREF_KEYS.parental, { enabled: true, pinHash: hashPin('482913'), allowlist: [] });
    render(<ParentalSection locked onLockChange={onLockChange} />);

    typePin('PIN', '111111');
    fireEvent.click(screen.getByLabelText('家长控制'));
    expect(screen.getByText('PIN 不正确')).toBeInTheDocument();
    expect(onLockChange).not.toHaveBeenCalled();

    typePin('PIN', '482913');
    fireEvent.click(screen.getByLabelText('家长控制'));
    expect(onLockChange).toHaveBeenCalledWith(false);
    expect(storedParental()).toEqual({ enabled: false, pinHash: null, allowlist: [] });
  });

  it('keeps the allowlist as trimmed entries', async () => {
    render(<ParentalSection locked={false} onLockChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('仅允许监控白名单目录'), {
      target: { value: 'D:\\a, E:\\b ,  ' },
    });
    await waitFor(() => {
      const stored = storedParental() as { allowlist: string[] };
      expect(stored.allowlist).toEqual(['D:\\a', 'E:\\b']);
    });
  });
});

describe('TrustedContactSection', () => {
  it('flags an invalid e-mail and clears the error for a valid one', () => {
    render(<TrustedContactSection />);
    const email = screen.getByLabelText('邮箱');

    fireEvent.change(email, { target: { value: 'not-an-email' } });
    expect(screen.getByText('邮箱格式不正确')).toBeInTheDocument();

    fireEvent.change(email, { target: { value: 'ops@example.com' } });
    expect(screen.queryByText('邮箱格式不正确')).not.toBeInTheDocument();
  });

  it('persists the condition and name', async () => {
    render(<TrustedContactSection />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '运维' } });
    fireEvent.change(screen.getByLabelText('通知条件'), { target: { value: 'always' } });
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(PREF_KEYS.trustedContact) ?? 'null');
      expect(stored).toEqual({ name: '运维', email: '', condition: 'always' });
    });
  });
});

describe('Section chrome', () => {
  it('uses the shared section frame with a title and hint', () => {
    render(<TrustedContactSection />);
    const section = document.querySelector('.settings-section');
    expect(section).toHaveClass('settings-section--wide');
    expect(within(section as HTMLElement).getByRole('heading', { level: 2 })).toHaveTextContent('信任联系人');
    expect(section?.querySelector('.eyebrow')).toHaveTextContent('Trusted contact');
    expect(section?.querySelector('.section-hint')).not.toBeNull();
  });
});

describe('VoiceSection', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');

  afterEach(() => {
    if (original) Object.defineProperty(window, 'speechSynthesis', original);
    else Reflect.deleteProperty(window, 'speechSynthesis');
  });

  it('renders the unavailable treatment when speechSynthesis is absent', () => {
    Reflect.deleteProperty(window, 'speechSynthesis');
    render(<VoiceSection />);

    const chip = screen.getByText('当前环境不支持语音合成');
    expect(chip).toHaveClass('state-chip--limited');
    expect(screen.getByLabelText('朗读事件')).toBeDisabled();
    expect(screen.getByLabelText('语速')).toBeDisabled();
    expect(screen.getByLabelText('音色')).toBeDisabled();
  });

  it('lists the voices the API reports and persists the choice', async () => {
    const voices = [{ name: 'Microsoft Huihui', voiceURI: 'zh-CN-huihui', lang: 'zh-CN' }];
    const listeners = new Set<() => void>();
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => voices,
        speak: vi.fn(),
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      },
    });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: class { text: string; rate = 1; voice: unknown = null; constructor(text: string) { this.text = text; } },
    });

    render(<VoiceSection />);
    expect(screen.queryByText('当前环境不支持语音合成')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Microsoft Huihui' })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('音色'), { target: { value: 'zh-CN-huihui' } });
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(PREF_KEYS.voice) ?? 'null')).toMatchObject({ voice: 'zh-CN-huihui' });
    });
  });
});

describe('PersonalizationSection', () => {
  afterEach(() => {
    delete document.documentElement.dataset.density;
  });

  it('publishes the density on the document and persists it', async () => {
    render(<PersonalizationSection accent="#e6b65b" onAccentChange={vi.fn()} />);
    expect(document.documentElement.dataset.density).toBe('comfortable');

    fireEvent.click(screen.getByRole('button', { name: '紧凑' }));

    expect(document.documentElement.dataset.density).toBe('compact');
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(PREF_KEYS.personalization) ?? 'null')).toEqual({ density: 'compact' });
    });
  });

  it('calls onAccentChange with the exact preset hex and marks the active chip', () => {
    const onAccentChange = vi.fn();
    render(<PersonalizationSection accent="#8b5cf6" onAccentChange={onAccentChange} />);

    const purple = screen.getByRole('button', { name: /紫色/ });
    expect(purple).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /蓝色/ }));
    expect(onAccentChange).toHaveBeenCalledWith('#2563eb');

    for (const value of ['#e6b65b', '#2563eb', '#0ea5e9', '#e05c93', '#8b5cf6']) {
      expect(document.querySelector(`.pref-swatch code`)?.textContent).toBeDefined();
      expect(screen.getByRole('group', { name: '强调色预设' }).textContent).toContain(value);
    }
  });

  it('offers exactly the five documented presets', () => {
    render(<PersonalizationSection accent="#e6b65b" onAccentChange={vi.fn()} />);
    expect(ACCENT_PRESETS.map((preset) => preset.value)).toEqual(['#e6b65b', '#2563eb', '#0ea5e9', '#e05c93', '#8b5cf6']);
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

describe('UsageSection', () => {
  it('computes every count from the fixtures', () => {
    render(<UsageSection sessions={sessions} events={events} />);

    const rows = document.querySelectorAll('.pref-row');
    expect(rows[0].textContent).toContain('发现进程');
    expect(rows[0].textContent).toContain('4');
    // Only the alive, enabled, unpaused session is writable.
    expect(rows[1].textContent).toContain('可写入');
    expect(rows[1].textContent).toContain('1');
    expect(rows[2].textContent).toContain('事件总数');
    expect(rows[2].textContent).toContain('3');
    expect(rows[3].textContent).toContain('最近事件');
    expect(rows[3].textContent).toContain('刚刚');

    expect(screen.getByText('injected')).toBeInTheDocument();
    expect(screen.getByText('activity')).toBeInTheDocument();
  });

  it('shows 暂无事件 for an empty event list', () => {
    render(<UsageSection sessions={sessions} events={[]} />);
    expect(screen.getAllByText('暂无事件').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.pref-list__item')).toHaveLength(0);
  });

  it('falls back to 未记录 when an event has neither a decision nor a type', () => {
    render(<UsageSection sessions={[]} events={[{ id: 'x', timestampMs: 1_000, type: '' }]} />);
    expect(screen.getByText('未记录')).toBeInTheDocument();
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

function desktopProps(overrides: Partial<Parameters<typeof ComputerControlSection>[0]> = {}) {
  return {
    allowReveal: true,
    onAllowRevealChange: vi.fn(),
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
  it('disables the tray row and explains why when the bridge is absent', () => {
    render(<ComputerControlSection {...desktopProps({ desktopBridgeAvailable: false })} />);

    expect(screen.getByLabelText('关闭时最小化到托盘')).toBeDisabled();
    expect(screen.getByText('需要桌面应用')).toHaveClass('state-chip--limited');
    expect(screen.getByLabelText('首选终端')).toBeDisabled();
  });

  it('reports tray changes only when available, and reflects the stored value', () => {
    const onCloseToTrayChange = vi.fn();
    render(<ComputerControlSection {...desktopProps({ closeToTray: true, onCloseToTrayChange })} />);

    const tray = screen.getByLabelText('关闭时最小化到托盘');
    expect(tray).toBeChecked();
    expect(screen.queryByText('需要桌面应用')).not.toBeInTheDocument();

    fireEvent.click(tray);
    expect(onCloseToTrayChange).toHaveBeenCalledWith(false);
  });

  it('reflects startup state, never optimistically, and is disabled while busy', () => {
    const onToggleStartup = vi.fn();
    const { rerender } = render(<ComputerControlSection {...desktopProps({ startupInstalled: false, onToggleStartup })} />);
    const startup = screen.getByLabelText('开机自启');
    expect(startup).not.toBeChecked();

    fireEvent.click(startup);
    expect(onToggleStartup).toHaveBeenCalledTimes(1);
    // Still unchecked: the row only ever reflects the prop.
    expect(startup).not.toBeChecked();

    rerender(<ComputerControlSection {...desktopProps({ startupInstalled: false, onToggleStartup, busy: true })} />);
    expect(screen.getByLabelText('开机自启')).toBeDisabled();
  });

  it('reflects the preferred terminal and reports a change', () => {
    const onPreferredTerminalChange = vi.fn();
    render(<ComputerControlSection {...desktopProps({ onPreferredTerminalChange })} />);
    expect(screen.getByLabelText('首选终端')).toHaveValue('powershell');

    fireEvent.change(screen.getByLabelText('首选终端'), { target: { value: 'windows-terminal' } });
    expect(onPreferredTerminalChange).toHaveBeenCalledWith('windows-terminal');
  });
});

describe('ShortcutsSection', () => {
  it('lists exactly the four honoured shortcuts and nothing more', () => {
    render(<ShortcutsSection />);
    const rows = document.querySelectorAll('.shortcuts-table tbody tr');
    expect(rows).toHaveLength(4);
    expect([...rows].map((row) => row.textContent)).toEqual([
      'Esc关闭侧栏抽屉或已打开的菜单',
      'Ctrl+1切换到进程',
      'Ctrl+2切换到事件',
      'Ctrl+3切换到设置',
    ]);
  });
});

describe('SnapshotsSection', () => {
  it('derives each snapshot from the props and shows 暂无快照 when empty', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    render(<SnapshotsSection sessions={sessions} environment={null} />);
    expect(screen.getByText('暂无快照')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '生成快照' }));
    const item = document.querySelector('.pref-list__item');
    expect(item?.textContent).toContain('进程 4');
    expect(item?.textContent).toContain('可写入 1');
    expect(item?.textContent).toContain('工具 0');

    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    const writeText = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    expect(JSON.parse(writeText.mock.calls[0][0] as string)).toMatchObject({
      sessionCount: 4, writableCount: 1, toolCount: 0,
    });
    await screen.findByText('已复制快照');

    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByText('暂无快照')).toBeInTheDocument();
    Reflect.deleteProperty(navigator, 'clipboard');
  });
});

describe('PetSection', () => {
  it('renders the ornament only when enabled and persists the form', async () => {
    render(<PetSection sessionCount={0} />);
    expect(document.querySelector('.workspace-pet')).toBeNull();

    fireEvent.click(screen.getByLabelText('桌面宠物'));
    const pet = document.querySelector('.workspace-pet');
    expect(pet).not.toBeNull();
    expect(pet).toHaveAttribute('aria-hidden', 'true');

    fireEvent.change(screen.getByLabelText('形象'), { target: { value: 'ring' } });
    await waitFor(() => expect(document.querySelector('.workspace-pet--ring')).not.toBeNull());
  });

  it('pulses briefly when the session count changes', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<PetSection sessionCount={1} />);
      fireEvent.click(screen.getByLabelText('桌面宠物'));
      expect(document.querySelector('.workspace-pet.is-pulsing')).toBeNull();

      rerender(<PetSection sessionCount={2} />);
      expect(document.querySelector('.workspace-pet.is-pulsing')).not.toBeNull();

      act(() => { vi.advanceTimersByTime(600); });
      expect(document.querySelector('.workspace-pet.is-pulsing')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
  it('shows the origin and theme, and opens the origin in a new tab', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<BrowserSection theme="dark" origin="http://127.0.0.1:4174" />);

    expect(screen.getByText('http://127.0.0.1:4174')).toBeInTheDocument();
    expect(screen.getByText('dark')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /在浏览器中打开/ }));
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:4174', '_blank', 'noreferrer');
    vi.unstubAllGlobals();
  });

  it('disables the button when there is no origin to open', () => {
    render(<BrowserSection theme="light" origin="" />);
    expect(screen.getByRole('button', { name: /在浏览器中打开/ })).toBeDisabled();
  });
});