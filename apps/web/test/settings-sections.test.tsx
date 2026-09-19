import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREF_KEYS,
  hashPin,
  isNotificationsPref,
  readPref,
  writePref,
} from '../src/settings/desktop-prefs';
import {
  ImportSection,
  NotificationsSection,
  ParentalSection,
  TrustedContactSection,
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
    localStorage.setItem(PREF_KEYS.notifications, JSON.stringify({ inPanel: 'yes' }));
    expect(readPref(PREF_KEYS.notifications, { inPanel: true }, isNotificationsPref)).toEqual({ inPanel: true });
  });

  it('round-trips a written value', () => {
    const value = { inPanel: false, onSuccess: true, onError: false, timelineLimit: 25 };
    writePref(PREF_KEYS.notifications, value);
    expect(readPref(PREF_KEYS.notifications, { inPanel: true }, isNotificationsPref)).toEqual(value);
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