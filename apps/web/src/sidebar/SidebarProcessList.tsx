import type { SessionView } from '../api/client';
import {
  formatSilence,
  groupSessionsByHost,
  sessionTone,
  sessionToneLabel,
  toolLabel,
} from './session-groups';

/**
 * The list of discovered processes, grouped by the application they run inside.
 *
 * It sits between the brand and the main navigation and scrolls on its own, so a long
 * list never pushes 事件/设置 or the footer out of reach. The selected row is
 * highlighted across its full width, and in the same accent as the process table's
 * active session, so the two views agree about what is selected.
 */
export function SidebarProcessList(props: {
  readonly sessions: readonly SessionView[];
  readonly selectedId: string | null;
  readonly onSelect: (session: SessionView) => void;
  readonly filter: string;
  readonly onFilterChange: (value: string) => void;
}) {
  const query = props.filter.trim().toLowerCase();
  const visible = query.length === 0
    ? props.sessions
    : props.sessions.filter((session) => {
      const haystack = [
        toolLabel(session.tool),
        session.host?.label ?? '',
        session.host?.windowTitle ?? '',
        String(session.rootPid),
        session.conversationId ?? '',
        session.sessionCwd ?? '',
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });

  const groups = groupSessionsByHost(visible);

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

      {/* A labelled group of buttons, not `role="list"` with `role="listitem"` rows.
          Putting `listitem` on a `<button>` overrides its button role: the rows stopped
          being exposed as activatable at all, so assistive technology announced a list
          item with no way to know it could be pressed. The rows stay buttons, which is
          what they are, and the group keeps the label. */}
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
              return (
                <button
                  key={session.id}
                  type="button"
                  className={`sidebar-processes__item ${selected ? 'is-selected' : ''}`}
                  aria-current={selected ? 'true' : undefined}
                  title={`${toolLabel(session.tool)} · PID ${session.rootPid} · ${sessionToneLabel(tone)}`}
                  onClick={() => props.onSelect(session)}
                >
                  <span className={`process-dot process-dot--${tone}`} aria-hidden="true" />
                  <span className="sidebar-processes__name">{toolLabel(session.tool)}</span>
                  <span className="sidebar-processes__meta">
                    {formatSilence(session.quietForMs ?? 0)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}