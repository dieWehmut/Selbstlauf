import { useI18n, translate, type Locale } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, ImageOff, Loader, Minimize2, RefreshCw } from 'lucide-react';

import type { SessionView } from '../api/client';
import type { WindowPreviewResult } from '../App';
import { describeShellReason } from './shell-reasons';

/**
 * A still of the window a process runs in, with a button to bring that window to the front.
 *
 * The preview shows a session the user *cannot* currently see: measured on this machine, a
 * window that is merely occluded (behind another) captures perfectly with its own content
 * intact, while a minimized one is not offered by the OS capture layer at all. So the two
 * ordinary states — minimized, and running in no window — are named in words rather than shown
 * as an empty frame, because "I can see nothing" is not a useful thing to tell someone.
 *
 * It is fetched on demand. One capture pass enumerates and captures every window on the machine
 * and costs about 300ms regardless of how many are open, so refreshing it on a timer would spend
 * that continuously for a picture that changes only when the user acts.
 */
export function SessionWindowPreview(props: {
  readonly session: SessionView;
  /** Absent outside the desktop shell, where no capture is possible. */
  readonly requestPreview?: (sessionId: string) => Promise<WindowPreviewResult>;
  readonly onOpenWindow?: (session: SessionView) => void;
  readonly busy?: boolean;
}) {
  const { t, locale } = useI18n();
  const [result, setResult] = useState<WindowPreviewResult | null>(null);
  const [pending, setPending] = useState(false);
  // A capture can outlive the session it was for, so a stale answer must not overwrite a newer
  // one — the same guard the rest of the app uses for overlapping requests.
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const request = props.requestPreview;
    if (request === undefined) {
      setResult({ state: 'unsupported', reason: '这个版本不能预览窗口' });
      return;
    }
    sequence.current += 1;
    const mine = sequence.current;
    setPending(true);
    try {
      const next = await request(props.session.id);
      if (mine === sequence.current) setResult(next);
    } catch (error) {
      if (mine === sequence.current) {
        setResult({ state: 'unsupported', reason: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (mine === sequence.current) setPending(false);
    }
  }, [props.requestPreview, props.session.id]);

  // Load once per session. Deliberately not on every poll: a poll would re-capture the whole
  // desktop on every tick.
  useEffect(() => {
    setResult(null);
    void load();
  }, [load]);

  const state = result?.state ?? null;
  const captured = result?.state === 'captured' ? result : null;

  return (
    <section className="window-preview" aria-label={t("窗口预览")}>
      <div className="window-preview__head">
        <span className="eyebrow">{t("窗口")}</span>
        <h3 className="window-preview__title">
          <AppWindow size={15} aria-hidden="true" />
          {t("窗口内容")}</h3>
        <div className="window-preview__actions">
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => void load()}
            aria-label={t("刷新窗口预览")}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {t("刷新")}</button>
          <button
            type="button"
            className="button"
            disabled={props.busy === true || result?.state === 'no-window'}
            onClick={() => props.onOpenWindow?.(props.session)}
            aria-label={t('切换到该窗口 PID {pid}', { pid: props.session.rootPid })}
          >
            <AppWindow size={15} aria-hidden="true" />
            {t("切换到该窗口")}</button>
        </div>
      </div>

      <div className="window-preview__frame">
        {pending && state === null && (
          <p className="window-preview__note"><Loader size={15} aria-hidden="true" />{t("正在抓取窗口画面…")}</p>
        )}

        {state === 'captured' && captured !== null && (
          <>
            <img
              className="window-preview__image"
              src={captured.dataUrl}
              alt={t('PID {pid} 所在窗口的画面', { pid: props.session.rootPid })}
              width={captured.width}
              height={captured.height}
            />
            <p className="window-preview__caption">
              {captured.sharedBy > 1
                // Two Codex sessions can run inside one Tabby window, so the picture is of the
                // window rather than of this process alone. Saying so prevents a wrong reading.
                ? t('此窗口内有 {count} 个受监控进程，画面为整个窗口', { count: captured.sharedBy })
                : t('PID {pid} 所在窗口', { pid: props.session.rootPid })}
              {props.session.host?.windowTitle ? ` · ${props.session.host.windowTitle}` : ''}
              {/* The window was minimized, so it was shown for a moment to capture it and put straight
                  back. Saying so explains why it may have blinked, and reassures that its state was kept. */}
              {captured.restoredFromMinimized === true ? t("（该窗口原本最小化，已临时显示后还原）") : ''}
            </p>
          </>
        )}

        {state === 'minimized' && (
          <p className="window-preview__note">
            <Minimize2 size={15} aria-hidden="true" />
            {/* A minimized window is shown briefly to capture it, so reaching this state means the window
                could not be shown at all — it has usually just closed, and a closed window and one that
                refuses to appear are indistinguishable here. The wording therefore says what is known
                rather than asserting the minimized case, which would give advice that cannot be followed
                once the window is gone. It also names the retry, which is what actually helps. */}
            {t("这一会儿抓不到该窗口的画面：它可能刚刚关闭，或无法被唤到画面上。点“刷新”再试一次。")}</p>
        )}

        {state === 'no-window' && (
          <p className="window-preview__note">
            <ImageOff size={15} aria-hidden="true" />
            {/* The reason is derived from the session rather than hardcoded. The message used to
                assert "DeepSeek Harness is a web UI" for *any* session with no window, but a null
                handle has several causes — a harness interface, a bare console or shell, or a host
                whose window lookup failed. That claim happens to be right for every session on this
                machine and is still wrong as a general statement: a Codex session in a bare console
                would have been told it was DeepSeek Harness. */}
            {noWindowReason(props.session, locale)}
          </p>
        )}

        {state === 'unsupported' && (
          <p className="window-preview__note">
            <ImageOff size={15} aria-hidden="true" />
            {result?.state === 'unsupported' && result.reason ? describeShellReason(result.reason, locale) : t("当前环境不支持窗口预览。")}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Why a session has no window to preview, stated from what the session actually reports.
 *
 * A null window handle has more than one cause, so this describes the host the service identified
 * rather than asserting a single explanation. The previous wording claimed every such session was
 * DeepSeek Harness, which is wrong for a session running in a bare console or an unrecognised host —
 * and a message about the wrong application is worse than a plain "there is nothing to show here".
 */
export function noWindowReason(session: SessionView, locale?: Locale): string {
  const host = session.host;
  const label = host?.label?.trim() ?? '';
  // A WSL session cannot have a window at all, which is a fact about Linux pids rather than a failure to
  // identify anything: the process runs in another kernel's pid namespace, so Windows has no window for it.
  if (session.distribution) {
    return translate('该进程运行在 WSL（{distribution}）里，Windows 没有它的窗口，因此没有可预览的画面。', { distribution: session.distribution }, locale);
  }
  // A harness session's interface is the browser page showing its WebUI, which is why it has no
  // window of its own.
  if (session.tool === 'dsh') {
    return translate('该进程没有自己的窗口（DeepSeek Harness 的界面是浏览器里的网页），因此没有可预览的画面。', {}, locale);
  }
  if (host === null || host === undefined || label.length === 0) {
    return translate('未识别出该进程所在的窗口，因此没有可预览的画面。', {}, locale);
  }
  // Name the host that was identified instead of guessing which kind it is.
  return translate('该进程没有可预览的窗口（运行位置：{host}）。', { host: label }, locale);
}
