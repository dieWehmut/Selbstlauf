import { useMemo, useState, type ComponentType } from 'react';
import {
  ArrowLeft,
  Bell,
  CircleUser,
  Download,
  Gauge,
  Globe,
  Info,
  Keyboard,
  MonitorCog,
  Palette,
  PawPrint,
  Plug,
  Power,
  Search,
  Wrench,
} from 'lucide-react';

/**
 * The settings navigation rail.
 *
 * The reference console groups its settings into two labelled categories rather
 * than a flat tab strip, so the rail is data-driven: one entry per section, in
 * the order the reference presents them. The rail owns only navigation and
 * filtering — every section's content lives in `./sections`.
 */

/** One selectable settings section. */
export interface SettingsSectionEntry {
  readonly id: string;
  readonly label: string;
  /** A lucide icon component, rendered with an explicit pixel size. */
  readonly icon: ComponentType<{ size?: number | string }>;
}

export interface SettingsCategory {
  readonly label: string;
  readonly entries: readonly SettingsSectionEntry[];
}

/**
 * The two categories and their sections.
 *
 * Every entry here must change something the application actually does. Several sections used
 * to be listed that changed nothing a person could observe — 家长控制 (a local-only PIN that
 * gated one switch), 信任联系人 (a name and an email that were never sent anywhere), 语音 (a
 * switch for a feature that has no implementation) and 使用统计 (counts of the things already
 * on screen) — and they have been removed rather than left as placeholders. What replaced them
 * are settings for behaviour this app really has: when it starts, what closing it does, how
 * much history it keeps, and where its files live.
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = Object.freeze([
  Object.freeze({
    label: '个人',
    entries: Object.freeze([
      Object.freeze({ id: 'general', label: '常规', icon: Gauge }),
      Object.freeze({ id: 'appearance', label: '外观', icon: Palette }),
      Object.freeze({ id: 'notifications', label: '通知', icon: Bell }),
      Object.freeze({ id: 'shortcuts', label: '键盘快捷键', icon: Keyboard }),
      Object.freeze({ id: 'profile', label: '个人资料', icon: CircleUser }),
      Object.freeze({ id: 'pet', label: '宠物', icon: PawPrint }),
    ]),
  }),
  Object.freeze({
    label: '集成',
    entries: Object.freeze([
      Object.freeze({ id: 'startup', label: '启动与托盘', icon: Power }),
      Object.freeze({ id: 'config', label: '续写与进程', icon: Wrench }),
      Object.freeze({ id: 'import', label: '导入历史', icon: Download }),
      Object.freeze({ id: 'computer-control', label: '电脑操控', icon: MonitorCog }),
      Object.freeze({ id: 'plugins', label: '插件', icon: Plug }),
      Object.freeze({ id: 'browser', label: '浏览器', icon: Globe }),
      Object.freeze({ id: 'account', label: '关于', icon: Info }),
    ]),
  }),
]);

/** Every section id, in rail order. */
export const SETTINGS_SECTION_IDS: readonly string[] = Object.freeze(
  SETTINGS_CATEGORIES.flatMap((category) => category.entries.map((entry) => entry.id)),
);

export interface SettingsRailProps {
  readonly active: string;
  readonly onSelect: (id: string) => void;
  /** Leave the settings page entirely. */
  readonly onBack: () => void;
}

export function SettingsRail(props: SettingsRailProps) {
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  // Filtering hides non-matching entries and empties categories; a category
  // label with no surviving entry would otherwise read as a dead heading.
  const categories = useMemo(() => {
    if (needle.length === 0) return SETTINGS_CATEGORIES;
    return SETTINGS_CATEGORIES
      .map((category) => ({
        label: category.label,
        entries: category.entries.filter((entry) => entry.label.toLowerCase().includes(needle)),
      }))
      .filter((category) => category.entries.length > 0);
  }, [needle]);

  const matches = categories.reduce((total, category) => total + category.entries.length, 0);

  return (
    <div className="settings-rail">
      <button className="settings-rail__back" type="button" onClick={props.onBack}>
        <ArrowLeft size={16} />
        <span>返回应用</span>
      </button>

      <div className="settings-rail__search">
        <Search size={15} />
        <input
          type="search"
          aria-label="搜索设置"
          placeholder="搜索设置…"
          value={query}
          // Inside the settings form, so Enter must not submit it.
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div
        className="settings-rail__list"
        role="tablist"
        aria-label="设置分区"
        aria-orientation="vertical"
        /*
          The rail declares itself a tablist, so it owes the WAI-ARIA tabs pattern:
          arrow keys move between tabs and Home/End jump to the ends. Without this,
          every one of the 18 tabs sat in the page tab order, so a keyboard user
          needed 18 Tab presses to reach the last section, and the arrow keys did
          nothing on a control that announces itself as a tab list.
        */
        onKeyDown={(event) => {
          const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1
            : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1
              : 0;
          const flat = categories.flatMap((category) => category.entries);
          const current = flat.findIndex((entry) => entry.id === props.active);
          let next = -1;
          if (step !== 0) next = current + step;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = flat.length - 1;
          else return;
          if (next < 0 || next >= flat.length) return;
          event.preventDefault();
          props.onSelect(flat[next].id);
          // Move focus with the selection, since the newly selected tab is the only
          // one in the tab order once the roving tabindex is in place.
          const list = event.currentTarget;
          requestAnimationFrame(() => {
            const buttons = list.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            buttons[next]?.focus();
          });
        }}
      >
        {categories.map((category) => (
          <div className="settings-rail__group" key={category.label}>
            <span className="settings-rail__category">{category.label}</span>
            {category.entries.map((entry) => {
              const Icon = entry.icon;
              const selected = entry.id === props.active;
              return (
                <button
                  key={entry.id}
                  className={selected ? 'settings-rail__item is-active' : 'settings-rail__item'}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  /* Roving tabindex: only the selected tab is reachable by Tab, and
                     the arrow keys move within the list. */
                  tabIndex={selected ? 0 : -1}
                  onClick={() => props.onSelect(entry.id)}
                >
                  <Icon size={16} />
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </div>
        ))}
        {matches === 0 && <p className="settings-rail__empty">无匹配设置</p>}
      </div>
    </div>
  );
}