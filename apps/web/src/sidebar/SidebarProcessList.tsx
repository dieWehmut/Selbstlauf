import { Pin, PinOff } from 'lucide-react';

import type { SessionView } from '../api/client';
import { conversationShortId, formatSilence, groupSessionsByHost, sessionTone, sessionToneLabel, toolLabel } from './session-groups';

/**
 * The list of discovered processes, grouped the way the reference sidebar groups its
 * conversations: a small grey heading, then compact two-line rows, with the selected row
 * highlighted across its full width and its pin control revealed on hover.
 *
 * Two lines per row:
 *
 *     ● Codex                                    12m 33s
 *       Goal · active · 01a0bd1e
 *
 * The host is not repeated on the row: it is the group heading directly above it. The
 * conversation id is shown, shortened, because two sessions of the same tool in the same
 * host are otherwise indistinguishable — that is what the id is for.
 *
 * Each row is a container with two children rather than one button, because a `<button>`
 * cannot contain another `<button>`: the pin control would be invalid HTML and unreachable.
 * The container is a `group` and the row body is the button that opens the process.
 */
export function SidebarProcessList(props: {
  readonly sessions: readonly SessionView[];
  readonly selectedId: string | null;
  readonly onSelect: (session: SessionView) => void;
  readonly filter: string;
  readonly onFilterChange: (value: string) => void;
  /** Ids in pin order; the pinned ones are lifted into their own group on top. */
  readonly pinnedIds: readonly string[];
  readonly onTogglePin: (session: SessionView) => void;
}) {
  const query = props.filter.trim().toLowerCase();
  const visible = query.length === 0
    ? props.sessions
    : props.sessions.filter((session) => {
      // Everything a row displays must be searchable, including the conversation line:
      // `Goal`, `等待输入` and `未关联` are visible text, so searching them must find the
      // row that shows them.
      const haystack = [
        toolLabel(session.tool),
        session.host?.label ?? '',
        session.host?.windowTitle ?? '',
        String(session.rootPid),
        session.conversationId ?? '',
        conversationLine(session),
        session.sessionCwd ?? '',
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });

  const groups = groupSessionsByHost(visible, props.pinnedIds);
  const pinned = new Set(props.pinnedIds);

  return (
    <div className="sidebar-processes">
      <div className="sidebar-processes__search">
        <input
          type="search"
          aria-label="搜索进程"
          placeholder="搜索进程…"
          value={props.filter}
          onChange={(event) => props.onFilterChange(event.target.value)}
          // Inside the app shell rather than a form, but Enter must not do anything
          // surprising if that ever changes.
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
        />
      </div>

      <div className="sidebar-processes__scroll" role="group" aria-label="进程列表">
        {groups.length === 0 && (
          <p className="sidebar-processes__empty">
            {query.length === 0 ? '尚未发现进程' : '没有匹配的进程'}
          </p>
        )}
        {groups.map((group) => (
          <div className="sidebar-processes__group" key={group.label}>
            <span className="sidebar-processes__heading">{group.label}</span>
            {group.sessions.map((session) => {
              const tone = sessionTone(session);
              const selected = session.id === props.selectedId;
              const isPinned = pinned.has(session.id);
              const line = conversationLine(session);
              return (
                <div
                  key={session.id}
                  className={`sidebar-row ${selected ? 'is-selected' : ''} ${isPinned ? 'is-pinned' : ''}`}
                >
                  <button
                    type="button"
                    className="sidebar-row__open"
                    aria-current={selected ? 'true' : undefined}
                    title={`${toolLabel(session.tool)} · PID ${session.rootPid} · ${sessionToneLabel(tone)} · ${line}`}
                    onClick={() => props.onSelect(session)}
                  >
                    <span className={`process-dot process-dot--${tone}`} aria-hidden="true" />
                    <span className="sidebar-row__text">
                      <span className="sidebar-row__top">
                        <span className="sidebar-row__label">{toolLabel(session.tool)}</span>
                        <span className="sidebar-row__meta">{formatSilence(session.quietForMs ?? 0)}</span>
                      </span>
                      <span className="sidebar-row__conversation" title={session.conversationId ?? undefined}>
                        {line}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-row__pin"
                    aria-pressed={isPinned}
                    aria-label={`${isPinned ? '取消置顶' : '置顶'} PID ${session.rootPid}`}
                    title={isPinned ? '取消置顶' : '置顶'}
                    onClick={() => props.onTogglePin(session)}
                  >
                    {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The conversation line a row shows: what kind of conversation it is, and a short id so two
 * sessions of one tool in one host stay distinguishable.
 */
export function conversationLine(session: SessionView): string {
  const kind = session.tool === 'dsh'
    ? (session.runningTurn ? '步骤执行中' : '等待输入')
    : (session.goal ? `Goal · ${session.goal.status}` : '普通对话');
  const short = conversationShortId(session.conversationId);
  return short === null ? kind : `${kind} · ${short}`;
}