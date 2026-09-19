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

/** Reads one event aloud. A no-op when the preference is off or unsupported. */
export function speakEvent(text: string, prefs: VoicePref): void {
  if (!prefs.enabled || text.trim().length === 0) return;
  const synth = speechSupport();
  if (!synth) return;
  try {
    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.rate = prefs.rate;
    if (prefs.voice) {
      const match = synth.getVoices().find((voice) => voice.voiceURI === prefs.voice || voice.name === prefs.voice);
      if (match) utterance.voice = match;
    }
    synth.speak(utterance);
  } catch {
    // Speech is a convenience; a hostile or partial API must never break the panel.
  }
}

/** Announces the newest audit event, tolerating a missing speech API entirely. */
export function announceLatest(prefs: VoicePref, event: AuditEvent): void {
  try {
    speakEvent(`${event.type}${event.sessionId ? ` ${event.sessionId}` : ''}`, prefs);
  } catch {
    // Never let an announcement failure surface as an application error.
  }
}

export function VoiceSection() {
  const [pref, setPref] = usePref(PREF_KEYS.voice, VOICE_DEFAULTS, isVoicePref);
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>([]);
  // The API object does not change over a session, so reading it during render is stable.
  const supported = speechSupport();
  const patch = (next: Partial<VoicePref>) => setPref({ ...pref, ...next });

  useEffect(() => {
    if (!supported) return;
    const refresh = () => setVoices(supported.getVoices());
    refresh();
    if (typeof supported.addEventListener === 'function') {
      supported.addEventListener('voiceschanged', refresh);
      return () => supported.removeEventListener('voiceschanged', refresh);
    }
    return undefined;
  }, [supported]);

  return (
    <Section
      eyebrow="Voice"
      title="语音朗读"
      hint="使用本机语音合成朗读事件，仅在受支持的浏览器中可用。"
      icon={<Volume2 size={20} />}
    >
      {!supported && (
        <p className="pref-result">
          <span className="state-chip state-chip--limited">
            <span className="state-chip__dot" />当前环境不支持语音合成
          </span>
        </p>
      )}
      <SwitchRow
        label="朗读事件"
        hint="新的审计事件到达时朗读一次"
        checked={pref.enabled}
        disabled={!supported}
        onChange={(enabled) => patch({ enabled })}
      />
      <div className="switch-row">
        <div>
          <strong>语速</strong>
          <span>0.5 到 2 倍速</span>
        </div>
        <span className="appearance-slider">
          <input
            aria-label="语速"
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            disabled={!supported}
            value={pref.rate}
            onChange={(event) => patch({ rate: Number(event.target.value) })}
          />
          <code>{pref.rate.toFixed(1)}</code>
        </span>
      </div>
      <div className="field-stack">
        <Field label="音色">
          <select
            aria-label="音色"
            disabled={!supported}
            value={pref.voice ?? ''}
            onChange={(event) => patch({ voice: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">系统默认</option>
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>
            ))}
          </select>
        </Field>
      </div>
    </Section>
  );
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

export function PersonalizationSection(props: {
  readonly accent: string;
  readonly onAccentChange: (accent: string) => void;
}) {
  const [pref, setPref] = usePref(PREF_KEYS.personalization, PERSONALIZATION_DEFAULTS, isPersonalizationPref);

  // Published on the document so unrelated CSS can react to the density choice.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.density = pref.density;
  }, [pref.density]);

  return (
    <Section
      eyebrow="Personalization"
      title="个性化"
      hint="调整界面密度，并选择强调色。"
      icon={<Palette size={20} />}
    >
      <div className="segmented segmented--labels" role="group" aria-label="界面密度">
        {([['comfortable', '舒适'], ['compact', '紧凑']] as const).map(([value, label]) => (
          <button
            key={value}
            className={pref.density === value ? 'segmented__option is-active' : 'segmented__option'}
            type="button"
            aria-pressed={pref.density === value}
            onClick={() => setPref({ density: value })}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="pref-field__label">强调色预设</p>
      <div className="pref-swatches" role="group" aria-label="强调色预设">
        {ACCENT_PRESETS.map((preset) => (
          <button
            key={preset.value}
            className={preset.value.toLowerCase() === props.accent.toLowerCase() ? 'pref-swatch is-active' : 'pref-swatch'}
            type="button"
            aria-pressed={preset.value.toLowerCase() === props.accent.toLowerCase()}
            onClick={() => props.onAccentChange(preset.value)}
          >
            <span className="pref-swatch__dot" style={{ background: preset.value }} />
            {preset.label}
            <code>{preset.value}</code>
          </button>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 8. Desktop pet                                                      */
/* ------------------------------------------------------------------ */

export const PET_FORMS = Object.freeze([
  { value: 'dot', label: '光点' },
  { value: 'square', label: '方块' },
  { value: 'ring', label: '圆环' },
] as const);

export function PetSection(props: { readonly sessionCount: number }) {
  const [pref, setPref] = usePref(PREF_KEYS.pet, PET_DEFAULTS, isPetPref);
  const [pulsing, setPulsing] = useState(false);
  const mounted = useRef(false);

  // The ornament reacts briefly whenever the number of live sessions changes.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return undefined;
    }
    setPulsing(true);
    const timer = window.setTimeout(() => setPulsing(false), 600);
    return () => window.clearTimeout(timer);
  }, [props.sessionCount]);

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
        checked={pref.enabled}
        onChange={(enabled) => setPref({ ...pref, enabled })}
      />
      <div className="field-stack">
        <Field label="形象">
          <select
            aria-label="形象"
            value={pref.form}
            onChange={(event) => setPref({ ...pref, form: event.target.value as PetForm })}
          >
            {PET_FORMS.map((form) => (
              <option key={form.value} value={form.value}>{form.label}</option>
            ))}
          </select>
        </Field>
      </div>
      {pref.enabled && (
        <div
          className={`workspace-pet workspace-pet--${pref.form}${pulsing ? ' is-pulsing' : ''}`}
          aria-hidden="true"
        />
      )}
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

export function UsageSection(props: {
  readonly sessions: readonly SessionView[];
  readonly events: readonly AuditEvent[];
}) {
  const now = Date.now();
  const writableCount = props.sessions.filter(isWritableSession).length;

  const breakdown = new Map<string, number>();
  for (const event of props.events) {
    const decision = typeof event.type === 'string' && event.type.trim().length > 0 ? event.type : '未记录';
    breakdown.set(decision, (breakdown.get(decision) ?? 0) + 1);
  }

  const newestMs = props.events.reduce<number | null>(
    (newest, event) => (newest === null || event.timestampMs > newest ? event.timestampMs : newest),
    null,
  );

  return (
    <Section eyebrow="Usage" title="使用统计" hint="全部数值由当前会话与事件列表实时计算。" icon={<ChartColumn size={20} />}>
      <div className="pref-rows">
        <div className="pref-row"><span>发现进程</span><span className="pref-row__value">{props.sessions.length}</span></div>
        <div className="pref-row"><span>可写入</span><span className="pref-row__value">{writableCount}</span></div>
        <div className="pref-row"><span>事件总数</span><span className="pref-row__value">{props.events.length}</span></div>
        <div className="pref-row">
          <span>最近事件</span>
          <span className="pref-row__value">{newestMs === null ? '暂无事件' : relativeAge(newestMs, now)}</span>
        </div>
      </div>
      <p className="pref-field__label">决策分布</p>
      <div className="pref-list">
        {breakdown.size === 0
          ? <p className="settings-rail-note">暂无事件</p>
          : [...breakdown.entries()].map(([decision, count]) => (
            <div className="pref-list__item" key={decision}>
              <span>{decision}</span>
              <span>{count}</span>
            </div>
          ))}
      </div>
    </Section>
  );
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
      title="系统集成"
      hint="开机自启、托盘行为，以及终端按钮使用的应用。"
      icon={<MonitorCog size={20} />}
    >
      <SwitchRow
        label="开机自启"
        hint="随系统启动自动运行 Selbstlauf"
        checked={props.startupInstalled}
        disabled={props.busy === true}
        onChange={() => void props.onToggleStartup()}
      />
      <SwitchRow
        label="允许打开运行位置"
        hint="关闭后进程表里的“打开运行位置”按钮将被禁用"
        checked={props.allowReveal}
        onChange={props.onAllowRevealChange}
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

export function SnapshotsSection(props: {
  readonly sessions: readonly SessionView[];
  readonly environment: EnvironmentView | null;
}) {
  const [snapshots, setSnapshots] = useState<readonly UsageSnapshot[]>([]);
  const [result, setResult] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const sequence = useRef(0);

  const take = () => {
    const atMs = Date.now();
    sequence.current += 1;
    const snapshot: UsageSnapshot = {
      id: `snapshot-${sequence.current}`,
      atMs,
      sessionCount: props.sessions.length,
      writableCount: props.sessions.filter(isWritableSession).length,
      toolCount: props.environment?.tools.length ?? 0,
    };
    setSnapshots((current) => [...current, snapshot]);
    setResult(null);
  };

  const copy = async (snapshot: UsageSnapshot) => {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new Error('当前环境不支持写入剪贴板');
      }
      await clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setResult({ ok: true, text: '已复制快照' });
    } catch (error) {
      setResult({ ok: false, text: `复制失败：${messageOf(error)}` });
    }
  };

  return (
    <Section
      eyebrow="Snapshots"
      title="快照"
      hint="记录此刻的进程与工具数量，方便前后对比。"
      icon={<Camera size={20} />}
    >
      <div className="pref-actions">
        <button className="button button--primary" type="button" onClick={take}>生成快照</button>
        <button
          className="button button--secondary"
          type="button"
          disabled={snapshots.length === 0}
          onClick={() => { setSnapshots([]); setResult(null); }}
        >
          清空
        </button>
      </div>
      {result && <ResultChip tone={result.ok ? 'ready' : 'error'}>{result.text}</ResultChip>}
      <div className="pref-list">
        {snapshots.length === 0
          ? <p className="settings-rail-note">暂无快照</p>
          : snapshots.map((snapshot) => (
            <div className="pref-list__item" key={snapshot.id}>
              <span>
                {new Date(snapshot.atMs).toLocaleTimeString()} · 进程 {snapshot.sessionCount} · 可写入 {snapshot.writableCount} · 工具 {snapshot.toolCount}
              </span>
              <button className="text-button" type="button" onClick={() => void copy(snapshot)}>复制</button>
            </div>
          ))}
      </div>
    </Section>
  );
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
      hint="这些提示词会依次拼接，作为手动续写时使用的提示。"
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
        <div className="pref-row"><span>当前主题</span><span className="pref-row__value">{props.theme}</span></div>
      </div>
      <div className="pref-actions">
        <button className="button button--secondary" type="button" disabled={props.origin.length === 0} onClick={open}>
          <ExternalLink size={16} />在浏览器中打开
        </button>
      </div>
    </Section>
  );
}