import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bell,
  Camera,
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
  Power,
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
  PET_DEFAULTS,
  PLUGINS_DEFAULTS,
  PREF_KEYS,
  PROFILE_DEFAULTS,
  TRUSTED_CONTACT_DEFAULTS,
  VOICE_DEFAULTS,
  hashPin,
  isNotificationsPref,
  isParentalPref,
  isPetPref,
  isPluginsPref,
  isProfilePref,
  isTrustedContactPref,
  isVoicePref,
  usePref,
  writePref,
  type NotificationsPref,
  type ParentalPref,
  type PetForm,
  type PetPref,
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
  /** The app holds these preferences, so a change has to reach it: the notice strip filters on them. */
  readonly onChange?: (pref: NotificationsPref) => void;
}) {
  const [pref, setPref] = usePref(PREF_KEYS.notifications, NOTIFICATIONS_DEFAULTS, isNotificationsPref);
  const patch = (next: Partial<NotificationsPref>) => {
    const updated = { ...pref, ...next };
    setPref(updated);
    props.onChange?.(updated);
  };

  const setLimit = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    const limit = Math.min(1_000, Math.max(1, Math.trunc(raw)));
    patch({ timelineLimit: limit });
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
        label="操作成功时提示"
        hint="成功完成一次操作后给出提示"
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

  /**
   * The profile is one field, because one field is what the app shows.
   *
   * 头像 (default/light/dark) and 备注 were stored, validated and rendered nowhere: no part of the app
   * had an avatar or a note to show, so both offered a change nobody could observe. This file's own
   * history has the precedent — sections that "changed nothing a person could observe" were removed
   * rather than kept as placeholders — so they are gone rather than given invented behaviour. A stored
   * value with those keys still validates, since only the fields that matter are checked.
   */
  return (
    <Section eyebrow="Profile" title="个人资料" hint="只保存在本机浏览器中，不会上传；账户弹窗的标题显示的即是这个名称。" icon={<UserRound size={20} />}>
      <div className="field-grid">
        <Field label="显示名称">
          <input value={pref.displayName} onChange={(event) => rename(event.target.value)} />
        </Field>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Parental control                                                 */
/* ------------------------------------------------------------------ */

const PIN_SHAPE = /^[0-9]{4,8}$/;


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


/* ------------------------------------------------------------------ */
/* 6. Voice                                                            */
/* ------------------------------------------------------------------ */

/** The speech API, or null when this environment has none. */
export function speechSupport(): SpeechSynthesis | null {
  if (typeof window === 'undefined') return null;
  const synth = window.speechSynthesis;
  if (!synth || typeof synth.getVoices !== 'function' || typeof synth.speak !== 'function') return null;
  return typeof window.SpeechSynthesisUtterance === 'function' ? synth : null;
}




/* ------------------------------------------------------------------ */
/* 7. Personalization                                                  */
/* ------------------------------------------------------------------ */

export const ACCENT_PRESETS = Object.freeze([
  { label: '琥珀', value: '#e6b65b' },
  { label: '蓝色', value: '#2563eb' },
  { label: '绿色', value: '#0ea5e9' },
  { label: '粉色', value: '#e05c93' },
  { label: '紫色', value: '#8b5cf6' },
] as const);


/* ------------------------------------------------------------------ */
/* 8. Desktop pet                                                      */
/* ------------------------------------------------------------------ */

export const PET_FORMS = Object.freeze([
  { value: 'dot', label: '光点' },
  { value: 'square', label: '方块' },
  { value: 'ring', label: '圆环' },
] as const);

/**
 * The desktop pet's controls.
 *
 * The ornament itself is drawn by the app shell, not here: this section used to render it, so it existed
 * only while this section was open — invisible while using the app, with a pulse that could only fire if
 * the session count changed during the visit. Its stylesheet is `position: fixed` at the window's
 * bottom-right, which is where the shell now puts it, on every page.
 */
export function PetSection(props: {
  readonly pet: PetPref;
  readonly onChange: (next: PetPref) => void;
}) {
  return (
    <Section
      eyebrow="Pet"
      title="桌面宠物"
      hint="在窗口右下角显示一个小小的状态装饰。"
      icon={<Cat size={20} />}
    >
      <SwitchRow
        label="桌面宠物"
        hint="会话数量变化时轻轻跳动一下"
        checked={props.pet.enabled}
        onChange={(enabled) => props.onChange({ ...props.pet, enabled })}
      />
      <div className="field-stack">
        <Field label="形象">
          <select
            aria-label="形象"
            value={props.pet.form}
            onChange={(event) => props.onChange({ ...props.pet, form: event.target.value as PetForm })}
          >
            {PET_FORMS.map((form) => (
              <option key={form.value} value={form.value}>{form.label}</option>
            ))}
          </select>
        </Field>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 9. Shortcuts                                                        */
/* ------------------------------------------------------------------ */

/** Exactly the shortcuts the application honours today. */
export const SHORTCUTS = Object.freeze([
  { keys: 'Esc', description: '关闭侧栏抽屉或已打开的菜单' },
  { keys: 'Ctrl+1', description: '切换到进程' },
  { keys: 'Ctrl+2', description: '切换到事件' },
  { keys: 'Ctrl+3', description: '切换到设置' },
  { keys: 'Ctrl+,', description: '切换到设置（与底部菜单上标注的按键一致）' },
] as const);

export function ShortcutsSection() {
  return (
    <Section eyebrow="Shortcuts" title="快捷键" hint="当前版本支持的键盘快捷键。" icon={<Keyboard size={20} />}>
      <table className="shortcuts-table">
        <thead>
          <tr>
            <th scope="col">按键</th>
            <th scope="col">作用</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((shortcut) => (
            <tr key={shortcut.keys}>
              <td><kbd className="shortcut-keys">{shortcut.keys}</kbd></td>
              <td>{shortcut.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 10. Usage                                                           */
/* ------------------------------------------------------------------ */

/** A coarse, honest age: minutes under an hour, hours under a day, then days. */
export function relativeAge(timestampMs: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - timestampMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function isWritableSession(session: SessionView): boolean {
  return session.alive === true && session.enabled === true && session.paused === false;
}

/**
 * The decision label an event carries. The service records the watchdog
 * decision in `details.decision`; other events only have a kind, and an event
 * with neither is reported as `未记录` rather than guessed at.
 */
export function eventDecision(event: AuditEvent): string {
  const recorded = event.details?.decision;
  if (typeof recorded === 'string' && recorded.trim().length > 0) return recorded;
  if (typeof event.type === 'string' && event.type.trim().length > 0) return event.type;
  return '未记录';
}


/* ------------------------------------------------------------------ */
/* 11. Account / about                                                 */
/* ------------------------------------------------------------------ */

const PROJECT_URL = 'https://github.com/dieWehmut/Selbstlauf';

export function AccountSection(props: {
  readonly connected: boolean;
  readonly running: boolean;
  readonly version: string;
}) {
  return (
    <Section eyebrow="About" title="关于" hint="版本信息与本地服务状态。" icon={<Info size={20} />}>
      <div className="about-card">
        <div className="about-card__id">
          <strong>Selbstlauf</strong>
          <span className="state-chip state-chip--ready">
            <span className="state-chip__dot" />版本 {props.version}
          </span>
        </div>
      </div>
      <div className="pref-links">
        <a className="button button--secondary" href={PROJECT_URL} target="_blank" rel="noreferrer">
          <Globe size={16} />官方网站
        </a>
        <a className="button button--secondary" href={PROJECT_URL} target="_blank" rel="noreferrer">
          <Github size={16} />GitHub
        </a>
        <a className="button button--secondary" href={`${PROJECT_URL}/releases`} target="_blank" rel="noreferrer">
          <ScrollText size={16} />更新日志
        </a>
      </div>
      <div className="pref-rows">
        <div className="pref-row">
          <span>本地服务</span>
          <span className="pref-row__value">{props.connected ? '已连接' : '未连接'}</span>
        </div>
        <div className="pref-row">
          <span>监控循环</span>
          <span className="pref-row__value">{props.running ? '运行中' : '已停止'}</span>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 12. Computer control                                                */
/* ------------------------------------------------------------------ */

export const TERMINAL_OPTIONS = Object.freeze([
  { value: 'system', label: '系统默认' },
  { value: 'cmd', label: '命令提示符' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'windows-terminal', label: 'Windows Terminal' },
] as const);

export function ComputerControlSection(props: {
  readonly allowReveal: boolean;
  readonly onAllowRevealChange: (allowed: boolean) => void;
}) {
  return (
    <Section
      eyebrow="Desktop"
      title="电脑操控"
      hint="控制本应用能对这台电脑做什么。"
      icon={<MonitorCog size={20} />}
    >
      <SwitchRow
        label="允许打开运行位置"
        hint="关闭后进程表里的“打开运行位置”按钮将被禁用"
        checked={props.allowReveal}
        onChange={props.onAllowRevealChange}
      />
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 12b. Startup and tray                                               */
/* ------------------------------------------------------------------ */

/**
 * How the desktop application starts and what closing its window does.
 *
 * These lived inside 电脑操控, which is about what the app may do to the machine, so the
 * window's own behaviour was filed under the wrong heading and was easy to miss.
 */
export function StartupSection(props: {
  readonly startupInstalled: boolean;
  readonly onToggleStartup: () => Promise<void> | void;
  readonly busy?: boolean;
  readonly closeToTray: boolean | null;
  readonly onCloseToTrayChange: (value: boolean) => void;
  readonly preferredTerminal: string | null;
  readonly onPreferredTerminalChange: (value: string) => void;
  readonly desktopBridgeAvailable: boolean;
}) {
  const bridge = props.desktopBridgeAvailable;
  const terminal = props.preferredTerminal ?? 'system';
  const knownTerminals = TERMINAL_OPTIONS.map((option) => option.value as string);
  // An unknown stored value is still shown honestly rather than silently replaced.
  const terminalOptions = knownTerminals.includes(terminal)
    ? TERMINAL_OPTIONS
    : [...TERMINAL_OPTIONS, { value: terminal, label: terminal }];

  return (
    <Section
      eyebrow="Desktop"
      title="启动与托盘"
      hint="开机自启、关闭窗口的行为，以及终端按钮使用的应用。"
      icon={<Power size={20} />}
    >
      <SwitchRow
        label="开机自启"
        hint="随系统启动自动运行 Selbstlauf"
        checked={props.startupInstalled}
        disabled={props.busy === true}
        onChange={() => void props.onToggleStartup()}
      />
      <SwitchRow
        label="关闭时最小化到托盘"
        hint="勾选后点击关闭按钮会隐藏到系统托盘，取消则直接退出应用"
        checked={props.closeToTray === true}
        disabled={!bridge}
        chip={!bridge && (
          <span className="state-chip state-chip--limited">
            <span className="state-chip__dot" />需要桌面应用
          </span>
        )}
        onChange={props.onCloseToTrayChange}
      />
      <div className="field-stack">
        <p className="section-hint">选择点击终端按钮时使用的终端应用（当前仅保存偏好）</p>
        <Field label="首选终端">
          <select
            aria-label="首选终端"
            disabled={!bridge}
            value={terminal}
            onChange={(event) => props.onPreferredTerminalChange(event.target.value)}
          >
            {terminalOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </Field>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 13. Snapshots                                                       */
/* ------------------------------------------------------------------ */

export interface UsageSnapshot {
  readonly id: string;
  readonly atMs: number;
  readonly sessionCount: number;
  readonly writableCount: number;
  readonly toolCount: number;
}


/* ------------------------------------------------------------------ */
/* 14. Plugins                                                         */
/* ------------------------------------------------------------------ */

export function PluginsSection() {
  const [pref, setPref] = usePref(PREF_KEYS.plugins, PLUGINS_DEFAULTS, isPluginsPref);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const add = () => {
    const value = draft.trim();
    if (value.length === 0) {
      setError('提示词不能为空');
      return;
    }
    setError('');
    setPref({ prompts: [...pref.prompts, value] });
    setDraft('');
  };

  const remove = (index: number) => {
    setPref({ prompts: pref.prompts.filter((_, position) => position !== index) });
  };

  return (
    <Section
      eyebrow="Plugins"
      title="续写插件"
      hint="这些提示词会依次拼接成一行，作为“立即续写”发送的提示；超过 4096 字符时不会发送。"
      icon={<Plug size={20} />}
    >
      <div className="pref-inline">
        <input
          aria-label="手动续写提示词"
          value={draft}
          placeholder="输入一条提示词"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
        />
        <button className="button button--secondary" type="button" onClick={add}>添加</button>
      </div>
      {error && <ResultChip tone="error">{error}</ResultChip>}
      {pref.prompts.length === 0
        ? <p className="settings-rail-note">暂无提示词</p>
        : (
          <>
            <div className="pref-list">
              {pref.prompts.map((prompt, index) => (
                <div className="pref-list__item" key={`${index}-${prompt}`}>
                  <span>{prompt}</span>
                  <button className="text-button" type="button" onClick={() => remove(index)}>移除</button>
                </div>
              ))}
            </div>
            <p className="settings-rail-note" data-testid="plugins-effective">合并后的提示词：{pref.prompts.join(' ')}</p>
          </>
        )}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 15. Browser                                                         */
/* ------------------------------------------------------------------ */

/**
 * The resolved theme's name, worded the way the appearance section words it.
 *
 * This panel printed the raw identifier — `dark`, `light` — next to 访问地址 and 在浏览器中打开, so the one
 * row that was not Chinese was also the one a person had to translate. The appearance section already names
 * these two things 深色 and 浅色 for the same choice.
 */
const THEME_NAMES: Readonly<Record<'light' | 'dark', string>> = Object.freeze({ light: '浅色', dark: '深色' });

export function BrowserSection(props: {
  readonly theme: 'light' | 'dark';
  readonly origin: string;
}) {
  const open = () => {
    if (props.origin.length === 0) return;
    window.open(props.origin, '_blank', 'noreferrer');
  };

  return (
    <Section
      eyebrow="Browser"
      title="浏览器访问"
      hint="在浏览器中打开同一个本机面板。"
      icon={<ExternalLink size={20} />}
    >
      <div className="pref-rows">
        <div className="pref-row"><span>访问地址</span><span className="pref-row__value">{props.origin}</span></div>
        <div className="pref-row"><span>当前主题</span><span className="pref-row__value">{THEME_NAMES[props.theme]}</span></div>
      </div>
      <div className="pref-actions">
        <button className="button button--secondary" type="button" disabled={props.origin.length === 0} onClick={open}>
          <ExternalLink size={16} />在浏览器中打开
        </button>
      </div>
    </Section>
  );
}