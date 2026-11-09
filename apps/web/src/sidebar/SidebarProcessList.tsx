import { useI18n, type Locale } from '../i18n';
import { ChevronDown, ChevronRight, Monitor, Pin, PinOff, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { SessionView } from '../api/client';
import { conversationLabel, conversationShortId, formatDuration, groupSessionsByEnvironment, quietMs, sessionActivity, sessionActivityLabel, sessionEnvironment, sessionProject, toolLabel } from './session-groups';
import { ToolIcon } from './ToolIcon';

export function SidebarProcessList(props: {
  readonly sessions: readonly SessionView[];
  readonly selectedId: string | null;
  readonly onSelect: (session: SessionView) => void;
  readonly filter: string;
  readonly onFilterChange: (value: string) => void;
  readonly pinnedIds: readonly string[];
  readonly onTogglePin: (session: SessionView) => void;
}) {
  const { t, locale } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const query = props.filter.trim().toLowerCase();
  const visible = props.sessions.filter((session) => {
    const haystack = [toolLabel(session.tool), session.host?.label, session.host?.windowTitle,
      `${toolLabel(session.tool)} · PID ${session.rootPid}`, session.conversationId, conversationLine(session, locale), session.conversationTitle,
      sessionProject(session, locale).label, sessionEnvironment(session, locale).label,
      sessionActivityLabel(sessionActivity(session), locale)].join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });
  const groups = groupSessionsByEnvironment(visible, props.pinnedIds, locale);
  const pinned = new Set(props.pinnedIds);
  const toggle = (id: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // Searching reveals matching children even if their environment was previously collapsed.
  const isOpen = (id: string) => query.length > 0 || !collapsed.has(id);
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"] .sidebar-row__pin`)?.focus();
  });

  return (
    <div className="sidebar-processes">
      <div className="sidebar-processes__title"><strong>{t('智能体')}</strong><span>{props.sessions.length}</span></div>
      <div className="sidebar-processes__search">
        <input type="search" aria-label={t('搜索进程')} placeholder={t('搜索项目或会话…')}
          value={props.filter} onChange={(event) => props.onFilterChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} />
      </div>
      <div className="sidebar-processes__scroll" role="group" aria-label={t('进程列表')}>
        {groups.length === 0 && <p className="sidebar-processes__empty">{query ? t('没有匹配的进程') : t('尚未发现进程')}</p>}
        {groups.map((group) => (
          <section className="sidebar-processes__group" key={group.id}>
            <button type="button" className="sidebar-processes__heading" aria-expanded={isOpen(group.id)} onClick={() => toggle(group.id)}>
              {isOpen(group.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {group.id === 'windows' ? <Monitor size={14} /> : <Terminal size={14} />}
              <span>{group.label}</span><span className="sidebar-group__count">{group.projects.reduce((sum, project) => sum + project.sessions.length, 0)}</span>
            </button>
            {isOpen(group.id) && group.projects.map((project) => (
              <div className="sidebar-project" key={project.id} data-project-id={`${group.id}:${project.id}`} data-project-path={project.path ?? ''}>
                {project.sessions.map((session) => {
                  const activity = sessionActivity(session);
                  const selected = session.id === props.selectedId;
                  const isPinned = pinned.has(session.id);
                  const conversation = session.conversationTitle?.trim() || conversationLine(session, locale);
                  const identity = `${toolLabel(session.tool)} · PID ${session.rootPid}`;
                  const description = `${project.label}\n${identity} · ${sessionActivityLabel(activity, locale)}\n${conversation}`;
                  return <div key={session.id} data-session-id={session.id} className={`sidebar-row ${selected ? 'is-selected' : ''} ${isPinned ? 'is-pinned' : ''}`}>
                    <button type="button" className="sidebar-row__open" aria-current={selected ? 'true' : undefined}
                      aria-label={description} title={description} onClick={() => props.onSelect(session)}>
                      <ToolIcon tool={session.tool} size={22} />
                      <span className="sidebar-row__text">
                        <span className="sidebar-row__top">
                          <span className="sidebar-row__label">{project.name}</span>
                          {project.sessions.length > 1 && <span className="sidebar-row__pid">{session.rootPid}</span>}
                          <span className={`agent-activity agent-activity--${activity}`}><span aria-hidden="true" />{sessionActivityLabel(activity, locale)}</span>
                        </span>
                        <span className="sidebar-row__bottom">
                          <span className="sidebar-row__path" title={project.label}>{project.path ?? identity}</span>
                          <span className="sidebar-row__meta" title={t('距上次活动')}>{formatDuration(quietMs(session))}</span>
                        </span>
                      </span>
                    </button>
                    <button type="button" className="sidebar-row__pin" aria-pressed={isPinned}
                      aria-label={t(isPinned ? '取消置顶 PID {pid}' : '置顶 PID {pid}', { pid: session.rootPid })}
                      title={isPinned ? t('取消置顶') : t('置顶')}
                      onClick={() => { pendingFocus.current = session.id; props.onTogglePin(session); }}>
                      {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                  </div>;
                })}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Search and accessible description fallback when an agent publishes no conversation title. */
export function conversationLine(session: SessionView, locale?: Locale): string {
  const kind = conversationLabel(session, locale);
  const short = conversationShortId(session.conversationId);
  return short === null ? kind : `${kind} · ${short}`;
}
