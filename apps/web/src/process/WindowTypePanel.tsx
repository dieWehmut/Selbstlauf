import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Keyboard, TriangleAlert } from 'lucide-react';

import type { SessionView } from '../api/client';
import type { WindowTypeResult } from '../App';

/**
 * Typing a line into the window a session runs in.
 *
 * This is the "drive the window's contents" capability. It is honest about its cost, because the cost is real:
 * measured, there is **no** route that both delivers synthesized input and leaves focus alone.
 *
 *     PostMessage(WM_CHAR) into a background window  -> delivers nothing
 *     SendInput                                      -> delivers, but only to the foreground window
 *     SetForegroundWindow from a background process  -> refused by Windows' foreground lock
 *     AttachThreadInput + SetFocus                   -> works, and visibly takes focus
 *     UI Automation ValuePattern                     -> child controls absent from the tree while minimized
 *
 * So the panel says before it acts that the target window will be brought forward for a moment and that the
 * previous window is restored afterwards. Saying it up front is the difference between a capability and a
 * surprise.
 *
 * The indirection matters as much: this names a **session**, never a window handle, and the desktop shell refuses
 * a window that hosts more than one session rather than guessing which pane the text should reach.
 */
export const WINDOW_TYPE_MAX_LENGTH = 4096;

/** Why the current draft cannot be typed, or null when it can. */
export function typingProblem(draft: string): string | null {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return '请输入要写入的内容';
  if (/[\r\n]/u.test(draft)) return '只能写入一行；换行请用「提交」逐条发送';
  if (draft.length > WINDOW_TYPE_MAX_LENGTH) return `不超过 ${WINDOW_TYPE_MAX_LENGTH} 个字符（当前 ${draft.length}）`;
  return null;
}

export function WindowTypePanel(props: {
  readonly session: SessionView;
  /** The window is typed into; absent outside the desktop shell. */
  readonly onType?: (sessionId: string, text: string, submit: boolean) => Promise<WindowTypeResult>;
  /** How many watched sessions share this window; more than one is refused. */
  readonly sharedBy?: number;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WindowTypeResult | null>(null);
  // A draft belongs to one session, so it must not follow the user to another one.
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    setDraft('');
    setResult(null);
    setBusy(false);
  }, [props.session.id]);

  const hasWindow = (props.session.host?.windowHandle ?? null) !== null;
  const sharedBy = props.sharedBy ?? 1;
  const shared = sharedBy > 1;
  const problem = typingProblem(draft);
  const canType = hasWindow && !shared && props.onType !== undefined;
  const disabled = !canType || problem !== null || busy;

  const send = useCallback(async (submit: boolean) => {
    if (disabled || props.onType === undefined) return;
    const mine = sequence.current;
    const text = draft.trim();
    setBusy(true);
    setResult(null);
    try {
      const outcome = await props.onType(props.session.id, text, submit);
      if (mine === sequence.current) {
        setResult(outcome);
        // Cleared only when it worked, so a refusal does not lose what was typed.
        if (outcome.ok) setDraft('');
      }
    } catch (cause) {
      if (mine === sequence.current) {
        setResult({ ok: false, reason: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally {
      if (mine === sequence.current) setBusy(false);
    }
  }, [disabled, draft, props]);

  return (
    <section className="window-type" aria-label="写入窗口">
      <div className="window-type__head">
        <span className="eyebrow">Input</span>
        <h3 className="window-type__title">把这一行写进窗口</h3>
      </div>

      <p className="window-type__cost">
        <TriangleAlert size={14} aria-hidden="true" />
        {/* The cost is stated before the act, not after it. */}
        发送时会把该窗口切到前台约 1 秒（Windows 不允许后台程序发送键盘输入），随后自动切回原来的窗口。
      </p>

      <form
        className="window-type__form"
        onSubmit={(event) => {
          event.preventDefault();
          void send(false);
        }}
      >
        <label className="window-type__field">
          <span className="sr-only">要写入该窗口的文字</span>
          <input
            type="text"
            value={draft}
            maxLength={WINDOW_TYPE_MAX_LENGTH}
            placeholder={canType ? '例如：继续，并按上面的计划做完' : '该会话当前不可写入'}
            disabled={!canType || busy}
            aria-invalid={problem !== null && draft.length > 0}
            aria-describedby="window-type-hint"
            onChange={(event) => {
              // A single-line field strips newlines itself; flattening keeps a paste from welding words together.
              setDraft(event.target.value.replace(/[\r\n]+/gu, ' '));
              setResult(null);
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text');
              if (!/[\r\n]/u.test(text)) return;
              event.preventDefault();
              const field = event.currentTarget;
              const start = field.selectionStart ?? field.value.length;
              const end = field.selectionEnd ?? field.value.length;
              const next = `${field.value.slice(0, start)}${text}${field.value.slice(end)}`.replace(/[\r\n]+/gu, ' ');
              setDraft(next.slice(0, WINDOW_TYPE_MAX_LENGTH));
              setResult(null);
            }}
          />
        </label>
        <button className="button" type="submit" disabled={disabled} aria-label={`写入窗口（不提交）PID ${props.session.rootPid}`}>
          <Keyboard size={16} aria-hidden="true" />
          写入
        </button>
        <button
          className="button button--primary"
          type="button"
          disabled={disabled}
          onClick={() => void send(true)}
          aria-label={`写入并回车 PID ${props.session.rootPid}`}
        >
          <CornerDownLeft size={16} aria-hidden="true" />
          写入并回车
        </button>
      </form>

      <p className="window-type__hint" id="window-type-hint">
        {!hasWindow
          ? '该会话没有可写入的窗口。'
          : shared
            // The refusal is stated as a reason, not as a disabled button with no explanation.
            ? <>该窗口内有 <strong>{sharedBy}</strong> 个受监控会话，写入会送到其中当前获得焦点的那个，无法确定是你选的那个，因此不允许写入。</>
            : <>将写入 <strong>PID {props.session.rootPid}</strong> 的窗口{props.session.host?.windowTitle ? `（${props.session.host.windowTitle}）` : ''}。</>}
      </p>

      {result !== null && !result.ok && (
        <p className="window-type__problem" role="alert">未能写入：{result.reason}</p>
      )}
      {result !== null && result.ok && (
        <p className="window-type__done" role="status">
          已写入 {result.typed ?? 0} 个字符{result.submitted === true ? '，并已回车' : ''}
          {/* Whether focus came back is part of the outcome, because taking it was the cost. */}
          {result.focusRestored === true ? '，焦点已切回' : '，焦点未切回（可能是原来的窗口已关闭）'}。
        </p>
      )}
    </section>
  );
}