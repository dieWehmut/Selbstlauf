import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, ImageOff, Loader, Minimize2, RefreshCw } from 'lucide-react';

import type { SessionView } from '../api/client';
import type { WindowPreviewResult } from '../App';

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
    <section className="window-preview" aria-label="窗口预览">
      <div className="window-preview__head">
        <span className="eyebrow">Window</span>
        <h3 className="window-preview__title">
          <AppWindow size={15} aria-hidden="true" />
          窗口内容
        </h3>
        <div className="window-preview__actions">
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => void load()}
            aria-label="刷新窗口预览"
          >
            <RefreshCw size={15} aria-hidden="true" />
            刷新
          </button>
          <button
            type="button"
            className="button"
            disabled={props.busy === true || result?.state === 'no-window'}
            onClick={() => props.onOpenWindow?.(props.session)}
            aria-label={`切换到该窗口 PID ${props.session.rootPid}`}
          >
            <AppWindow size={15} aria-hidden="true" />
            切换到该窗口
          </button>
        </div>
      </div>

      <div className="window-preview__frame">
        {pending && state === null && (
          <p className="window-preview__note"><Loader size={15} aria-hidden="true" />正在抓取窗口画面…</p>
        )}

        {state === 'captured' && captured !== null && (
          <>
            <img
              className="window-preview__image"
              src={captured.dataUrl}
              alt={`PID ${props.session.rootPid} 所在窗口的画面`}
              width={captured.width}
              height={captured.height}
            />
            <p className="window-preview__caption">
              {captured.sharedBy > 1
                // Two Codex sessions can run inside one Tabby window, so the picture is of the
                // window rather than of this process alone. Saying so prevents a wrong reading.
                ? `此窗口内有 ${captured.sharedBy} 个受监控进程，画面为整个窗口`
                : `PID ${props.session.rootPid} 所在窗口`}
              {props.session.host?.windowTitle ? ` · ${props.session.host.windowTitle}` : ''}
            </p>
          </>
        )}

        {state === 'minimized' && (
          <p className="window-preview__note">
            <Minimize2 size={15} aria-hidden="true" />
            {/* Worded as "not capturable" rather than "minimized": a minimized window and one that
                has just closed are indistinguishable to the capture layer — both are simply absent
                from the window list, with no separate signal — so naming only the minimized case
                would give advice that cannot be followed once the window is gone. */}
            无法抓取该窗口的画面。通常是最小化了，还原它后点“刷新”即可查看。
          </p>
        )}

        {state === 'no-window' && (
          <p className="window-preview__note">
            <ImageOff size={15} aria-hidden="true" />
            该进程没有自己的窗口（DeepSeek Harness 是网页界面），因此没有可预览的画面。
          </p>
        )}

        {state === 'unsupported' && (
          <p className="window-preview__note">
            <ImageOff size={15} aria-hidden="true" />
            {result?.state === 'unsupported' && result.reason ? result.reason : '当前环境不支持窗口预览。'}
          </p>
        )}
      </div>
    </section>
  );
}