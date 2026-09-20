import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, TriangleAlert } from 'lucide-react';

import type { SessionView } from '../api/client';

/**
 * A field for writing a line into a session.
 *
 * The app already writes text into sessions — 立即续写 sends the configured continuation prompt — so
 * this is not a new capability class, it is letting the person choose the words. That was the second
 * half of the original request ("be able to operate the input bar"), and it is done through the app's
 * own validated transport rather than by synthesising keystrokes, because a keystroke reaches only a
 * *foreground* window and a continuation has to arrive while the user is looking elsewhere.
 *
 * The rules mirror what the service enforces, so a refusal is explained here rather than arriving as an
 * HTTP 400 the person cannot interpret: one line, at most 4096 characters.
 *
 * **Newlines are handled at the field, not by validation.** Measured: `<input type="text">` applies the
 * HTML value-sanitization algorithm, so a pasted multi-line block arrives with its line breaks *deleted* —
 * `line one\nline two` became `line oneline two`. A rule that merely rejected newlines would never fire,
 * because no newline ever reaches the component; the text would simply be corrupted before the user could
 * see it. The field therefore converts line breaks to spaces as they are pasted, so what is sent is what
 * the person wrote.
 */
export const PROMPT_MAX_LENGTH = 4096;

/**
 * Collapse line breaks into single spaces.
 *
 * Applied on paste and on input, because a single-line field deletes them silently otherwise.
 */
export function flattenPrompt(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ');
}

/** Why the current draft cannot be sent, or null when it can. */
export function promptProblem(draft: string): string | null {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return '请输入要发送的内容';
  // Kept as a guard even though the field cannot hold a newline: the component is also used with a
  // draft set programmatically, and the service would refuse one outright.
  if (/[\r\n]/u.test(draft)) return '只能发送一行；请删掉换行';
  if (draft.length > PROMPT_MAX_LENGTH) return `不超过 ${PROMPT_MAX_LENGTH} 个字符（当前 ${draft.length}）`;
  return null;
}

export function SessionPromptComposer(props: {
  readonly session: SessionView;
  /** Refuses when the session cannot accept input, matching the one-click action. */
  readonly canSend: boolean;
  readonly busy?: boolean;
  /**
   * Send the line, reporting whether it was actually written.
   *
   * The outcome matters: with Dry Run enabled the service answers successfully and writes nothing, so a
   * caller that treated that as a write would tell the user their line was delivered when it was not.
   */
  readonly onSend?: (session: SessionView, prompt: string) => Promise<{ readonly dryRun: boolean }> | { readonly dryRun: boolean } | void;
}) {
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The draft belongs to a session, so it must not follow the user to another one.
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    setDraft('');
    setSent(null);
    setDryRun(false);
    setError(null);
  }, [props.session.id]);

  const problem = promptProblem(draft);
  const disabled = !props.canSend || problem !== null || props.busy === true || props.onSend === undefined;

  const submit = useCallback(async () => {
    if (disabled || props.onSend === undefined) return;
    const mine = sequence.current;
    setError(null);
    const text = draft.trim();
    try {
      const outcome = await props.onSend(props.session, text);
      if (mine === sequence.current) {
        setDraft('');
        setSent(text);
        // A dry run reports success without writing, so it must not be announced as a delivery.
        setDryRun(outcome?.dryRun === true);
      }
    } catch (cause) {
      if (mine === sequence.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, [disabled, draft, props]);

  return (
    <section className="prompt-composer" aria-label="写入会话">
      <div className="prompt-composer__head">
        <span className="eyebrow">Input</span>
        <h3 className="prompt-composer__title">写入这一行</h3>
      </div>

      <form
        className="prompt-composer__form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="prompt-composer__field">
          <span className="sr-only">要发送到该会话的文字</span>
          <input
            type="text"
            // A single-line field, because the service accepts exactly one line and a textarea would
            // invite a newline the user cannot send.
            value={draft}
            maxLength={PROMPT_MAX_LENGTH}
            placeholder={props.canSend ? '例如：继续，并按上面的计划做完' : '该会话当前不可写入'}
            disabled={!props.canSend || props.busy === true}
            aria-invalid={problem !== null && draft.length > 0}
            aria-describedby="prompt-composer-hint"
            onChange={(event) => {
              // Flattened here too: a paste, an IME commit or a scripted value all arrive this way.
              setDraft(flattenPrompt(event.target.value));
              setSent(null);
            }}
            onPaste={(event) => {
              // Explicit paste handling, so a multi-line block becomes spaced words instead of the
              // browser silently welding the lines together.
              const text = event.clipboardData.getData('text');
              if (!/[\r\n]/u.test(text)) return;
              event.preventDefault();
              const field = event.currentTarget;
              const start = field.selectionStart ?? field.value.length;
              const end = field.selectionEnd ?? field.value.length;
              const next = flattenPrompt(`${field.value.slice(0, start)}${text}${field.value.slice(end)}`);
              setDraft(next.slice(0, PROMPT_MAX_LENGTH));
              setSent(null);
            }}
            // Enter submits through the form; there is no modifier, because this field holds one line.
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) event.stopPropagation();
            }}
          />
        </label>
        <button
          className="button button--primary"
          type="submit"
          disabled={disabled}
          aria-label={`发送到 PID ${props.session.rootPid}`}
        >
          {props.busy === true ? <RefreshCwSpinner /> : <Send size={16} aria-hidden="true" />}
          发送
        </button>
      </form>

      <p className="prompt-composer__hint" id="prompt-composer-hint">
        {/* Says exactly where the text goes, because this writes into a running session. */}
        {props.canSend
          ? <>将作为一行输入写入 <strong>PID {props.session.rootPid}</strong>，与“立即续写”走同一条通道。</>
          : <span className="prompt-composer__blocked"><TriangleAlert size={14} aria-hidden="true" />该会话不可写入，因此无法发送。</span>}
      </p>

      {problem !== null && draft.length > 0 && (
        <p className="prompt-composer__problem" role="alert">{problem}</p>
      )}
      {error !== null && <p className="prompt-composer__problem" role="alert">发送失败：{error}</p>}
      {sent !== null && (
        <p className={dryRun ? 'prompt-composer__problem' : 'prompt-composer__sent'} role="status">
          {/* A dry run answers successfully and writes nothing, so saying 已发送 would be a false report of
              delivery. It is stated as a skip instead, matching what the service records in its audit. */}
          {dryRun
            ? <>未真正写入（Dry Run）：<code>{sent}</code>　只记录了跳过，没有发送到会话。</>
            : <>已发送：<code>{sent}</code></>}
        </p>
      )}
    </section>
  );
}

/** A small spinner, so the send button shows progress without pulling in another icon name. */
function RefreshCwSpinner() {
  return (
    <span className="prompt-composer__spinner" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 3v6h-6" />
      </svg>
    </span>
  );
}