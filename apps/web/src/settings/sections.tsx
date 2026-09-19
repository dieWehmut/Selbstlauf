import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  Bell,
  Cat,
  ChartColumn,
  ClipboardPaste,
  ExternalLink,
  Github,
  Globe,
  Info,
  Keyboard,
  Mail,
  MonitorCog,
  Palette,
  Plug,
  ScrollText,
  ShieldCheck,
  Upload,
  UserRound,
  Volume2,
} from 'lucide-react';
import type { AuditEvent, EnvironmentView, SessionView } from '../api/client';
import {
  NOTIFICATIONS_DEFAULTS,
  PARENTAL_DEFAULTS,
  PERSONALIZATION_DEFAULTS,
  PET_DEFAULTS,
  PLUGINS_DEFAULTS,
  PREF_KEYS,
  PROFILE_DEFAULTS,
  TRUSTED_CONTACT_DEFAULTS,
  VOICE_DEFAULTS,
  hashPin,
  isNotificationsPref,
  isParentalPref,
  isPersonalizationPref,
  isPetPref,
  isPluginsPref,
  isProfilePref,
  isTrustedContactPref,
  isVoicePref,
  readPref,
  usePref,
  writePref,
  type NotificationsPref,
  type ParentalPref,
  type PetForm,
  type ProfilePref,
  type TrustedContactCondition,
  type TrustedContactPref,
  type VoicePref,
} from './desktop-prefs';
import './sections.css';

/* ------------------------------------------------------------------ */
/* Shared building blocks                                              */
/* ------------------------------------------------------------------ */

/** The one section frame every settings page uses. */
function Section(props: {
  readonly eyebrow: string;
  readonly title: string;
  readonly hint: string;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="settings-section settings-section--wide">
      <div className="section-title">
        <div>
          <span className="eyebrow">{props.eyebrow}</span>
          <h2>{props.title}</h2>
        </div>
        {props.icon}
      </div>
      <p className="section-hint">{props.hint}</p>
      {props.children}
    </section>
  );
}

/** A `switch-row` whose checkbox carries the row label as its accessible name. */
function SwitchRow(props: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly chip?: ReactNode;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <div className="switch-row">
      <div>
        <strong>{props.label}</strong>
        <span>{props.hint}</span>
      </div>
      {props.chip}
      <label className="switch">
        <input
          aria-label={props.label}
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled === true}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <span />
      </label>
    </div>
  );
}

/** An inline outcome line, always paired with the real message. */
function ResultChip(props: { readonly tone: 'ready' | 'error'; readonly children: ReactNode }) {
  return (
    <p className={`pref-result state-chip state-chip--${props.tone}`} role="status">
      <span className="state-chip__dot" />
      {props.children}
    </p>
  );
}

/** A labelled field whose decorative text lives outside the control itself. */
function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="pref-field">
      <span className="pref-field__label">{props.label}</span>
      {props.children}
    </label>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* 1. Notifications                                                    */
/* ------------------------------------------------------------------ */

export function NotificationsSection(props: {
  readonly onTimelineLimitChange?: (limit: number) => void;
}) {
  const [pref, setPref] = usePref(PREF_KEYS.notifications, NOTIFICATIONS_DEFAULTS, isNotificationsPref);
  const patch = (next: Partial<NotificationsPref>) => setPref({ ...pref, ...next });

  const setLimit = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    const limit = Math.min(1_000, Math.max(1, Math.trunc(raw)));
    patch({ timelineLimit: limit });
    props.onTimelineLimitChange?.(limit);
  };

  return (
    <Section eyebrow="Notifications" title="通知" hint="控制面板内提示，以及事件时间线保留的条数。" icon={<Bell size={20} />}>
      <SwitchRow
        label="面板内通知"
        hint="在面板内显示状态变化提示"
        checked={pref.inPanel}
        onChange={(inPanel) => patch({ inPanel })}
      />
      <SwitchRow
        label="续写成功时提示"
        hint="成功写入一次续写后给出提示"
        checked={pref.onSuccess}
        onChange={(onSuccess) => patch({ onSuccess })}
      />
      <SwitchRow
        label="出现错误时提示"
        hint="写入失败或传输异常时给出提示"
        checked={pref.onError}
        onChange={(onError) => patch({ onError })}
      />
      <div className="switch-row">
        <div>
          <strong>保留最近事件条数</strong>
          <span>超出后只保留最近的记录（1 - 1000）</span>
        </div>
        <input
          aria-label="保留最近事件条数"
          className="pref-number"
          type="number"
          min={1}
          max={1_000}
          value={pref.timelineLimit}
          onChange={(event) => setLimit(Number(event.target.value))}
        />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Import                                                           */
/* ------------------------------------------------------------------ */

type ImportKind = 'theme' | 'config';

export function ImportSection(props: {
  readonly onImportTheme: (text: string) => Promise<void> | void;
  readonly onImportConfig: (text: string) => Promise<void> | void;
}) {
  const [result, setResult] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const [busy, setBusy] = useState<ImportKind | null>(null);

  const run = async (kind: ImportKind) => {
    setBusy(kind);
    setResult(null);
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.readText !== 'function') {
        throw new Error('当前环境不支持读取剪贴板');
      }
      const text = await clipboard.readText();
      // Parse here so a failure is reported with the real parser message.
      const parsed: unknown = JSON.parse(text);
      const apply = kind === 'theme' ? props.onImportTheme : props.onImportConfig;
      await apply(text);
      void parsed;
      setResult({ ok: true, text: kind === 'theme' ? '已导入主题' : '已导入配置' });
    } catch (error) {
      setResult({ ok: false, text: `导入失败：${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section eyebrow="Import" title="导入" hint="从剪贴板读取 JSON，交给应用校验并应用。" icon={<Upload size={20} />}>
      <div className="pref-actions">
        <button className="button button--secondary" type="button" disabled={busy !== null} onClick={() => void run('theme')}>
          <ClipboardPaste size={16} />导入主题
        </button>
        <button className="button button--secondary" type="button" disabled={busy !== null} onClick={() => void run('config')}>
          <ClipboardPaste size={16} />导入配置
        </button>
      </div>
      {result && <ResultChip tone={result.ok ? 'ready' : 'error'}>{result.text}</ResultChip>}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Profile                                                          */
/* ------------------------------------------------------------------ */

export function ProfileSection(props: {
  readonly onDisplayNameChange?: (name: string) => void;
}) {
  const [pref, setPref] = usePref(PREF_KEYS.profile, PROFILE_DEFAULTS, isProfilePref);
  const patch = (next: Partial<ProfilePref>) => setPref({ ...pref, ...next });

  const rename = (displayName: string) => {
    patch({ displayName });
    props.onDisplayNameChange?.(displayName);
  };

  return (
    <Section eyebrow="Profile" title="个人资料" hint="这些内容只保存在本机浏览器中，不会上传。" icon={<UserRound size={20} />}>
      <div className="field-grid">
        <Field label="显示名称">
          <input value={pref.displayName} onChange={(event) => rename(event.target.value)} />
        </Field>
        <Field label="头像">
          <select
            aria-label="头像"
            value={pref.avatar}
            onChange={(event) => patch({ avatar: event.target.value as ProfilePref['avatar'] })}
          >
            <option value="default">默认</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </Field>
      </div>
      <div className="field-stack">
        <Field label="备注">
          <textarea rows={3} value={pref.note} onChange={(event) => patch({ note: event.target.value })} />
        </Field>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Parental control                                                 */
/* ------------------------------------------------------------------ */

const PIN_SHAPE = /^[0-9]{4,8}$/;

export function ParentalSection(props: {
  readonly locked: boolean;
  readonly onLockChange: (locked: boolean) => void;
}) {
  const [pref, setPref] = usePref(PREF_KEYS.parental, PARENTAL_DEFAULTS, isParentalPref);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  const setAllowlist = (allowlist: string) => {
    const entries = allowlist
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    setPref({ ...pref, allowlist: entries });
  };

  const enable = () => {
    if (!PIN_SHAPE.test(pin)) {
      setError('PIN 需要 4 到 8 位数字');
      return;
    }
    if (pin !== confirm) {
      setError('两次输入的 PIN 不一致');
      return;
    }
    setError('');
    // Only the obfuscated hash is stored; the plaintext PIN is dropped here.
    setPref({ enabled: true, pinHash: hashPin(pin), allowlist: pref.allowlist });
    setPin('');
    setConfirm('');
    props.onLockChange(true);
  };

  const disable = () => {
    if (pref.pinHash === null || hashPin(pin) !== pref.pinHash) {
      setError('PIN 不正确');
      return;
    }
    setError('');
    setPref({ enabled: false, pinHash: null, allowlist: pref.allowlist });
    setPin('');
    setConfirm('');
    props.onLockChange(false);
  };

  return (
    <Section
      eyebrow="Parental"
      title="家长控制"
      hint="本机 PIN 锁只用于避免误操作，不构成安全边界。"
      icon={<ShieldCheck size={20} />}
    >
      <SwitchRow
        label="家长控制"
        hint={pref.enabled ? '已启用：关闭需要重新输入 PIN' : '启用后需要 PIN 才能关闭'}
        checked={pref.enabled}
        onChange={(next) => {
          if (next) enable();
          else disable();
        }}
      />
      <div className="pref-pin-fields">
        <div className="pref-field">
          <span className="pref-field__label">PIN</span>
          <input
            aria-label="PIN"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(event) => setPin(event.target.value.trim())}
          />
        </div>
        {!pref.enabled && (
          <div className="pref-field">
            <span className="pref-field__label">确认 PIN</span>
            <input
              aria-label="确认 PIN"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value.trim())}
            />
          </div>
        )}
      </div>
      <div className="field-stack">
        <Field label="仅允许监控白名单目录">
          <input
            aria-label="仅允许监控白名单目录"
            value={pref.allowlist.join(', ')}
            placeholder="用英文逗号分隔"
            onChange={(event) => setAllowlist(event.target.value)}
          />
        </Field>
      </div>
      {error && <ResultChip tone="error">{error}</ResultChip>}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 5. Trusted contact                                                  */
/* ------------------------------------------------------------------ */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const TRUSTED_CONDITION_LABELS: Readonly<Record<TrustedContactCondition, string>> = Object.freeze({
  severe: '仅严重错误',
  any: '任何错误',
  always: '始终',
});

/** One-line summary other sections can show without importing the whole row. */
export function describeTrustedContact(value: TrustedContactPref): string {
  const name = value.name.trim() || '未设置联系人';
  const email = value.email.trim() || '未设置邮箱';
  return `${name} · ${email} · ${TRUSTED_CONDITION_LABELS[value.condition]}`;
}

export function TrustedContactSection() {
  const [pref, setPref] = usePref(PREF_KEYS.trustedContact, TRUSTED_CONTACT_DEFAULTS, isTrustedContactPref);
  const patch = (next: Partial<TrustedContactPref>) => setPref({ ...pref, ...next });
  const emailInvalid = pref.email.trim().length > 0 && !EMAIL_SHAPE.test(pref.email.trim());

  return (
    <Section
      eyebrow="Trusted contact"
      title="信任联系人"
      hint="在本机记录一位联系人，以及触发提醒的条件。"
      icon={<Mail size={20} />}
    >
      <div className="field-grid">
        <Field label="名称">
          <input value={pref.name} onChange={(event) => patch({ name: event.target.value })} />
        </Field>
        <Field label="邮箱">
          <input value={pref.email} onChange={(event) => patch({ email: event.target.value })} />
        </Field>
      </div>
      <div className="field-stack">
        <Field label="通知条件">
          <select
            aria-label="通知条件"
            value={pref.condition}
            onChange={(event) => patch({ condition: event.target.value as TrustedContactCondition })}
          >
            <option value="severe">仅严重错误</option>
            <option value="any">任何错误</option>
            <option value="always">始终</option>
          </select>
        </Field>
      </div>
      {emailInvalid && <ResultChip tone="error">邮箱格式不正确</ResultChip>}
      <p className="settings-rail-note">{describeTrustedContact(pref)}</p>
    </Section>
  );
}