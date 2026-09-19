import { useMemo, useState, type ComponentType } from 'react';
import {
  ArrowLeft,
  Bell,
  Camera,
  CircleUser,
  Download,
  Gauge,
  Globe,
  Keyboard,
  Mic,
  MonitorCog,
  Palette,
  PawPrint,
  Plug,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
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
 * The two categories and their sections, in reference order.
 *
 * A section with no component yet is still listed, because the rail is the
 * documented map of the console; `SettingsRail` marks which one is in view.
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = Object.freeze([
  Object.freeze({
    label: '个人',
    entries: Object.freeze([
      Object.freeze({ id: 'general', label: '常规', icon: Gauge }),
      Object.freeze({ id: 'notifications', label: '通知', icon: Bell }),
      Object.freeze({ id: 'import', label: '导入', icon: Download }),
      Object.freeze({ id: 'profile', label: '个人资料', icon: CircleUser }),
      Object.freeze({ id: 'appearance', label: '外观', icon: Palette }),
      Object.freeze({ id: 'parental', label: '家长控制', icon: ShieldCheck }),
      Object.freeze({ id: 'trusted-contact', label: 'Trusted contact', icon: UserCheck }),
      Object.freeze({ id: 'voice', label: '语音', icon: Mic }),
      Object.freeze({ id: 'config', label: '配置', icon: Wrench }),
      Object.freeze({ id: 'personalization', label: '个性化', icon: SlidersHorizontal }),
      Object.freeze({ id: 'pet', label: '宠物', icon: PawPrint }),
      Object.freeze({ id: 'shortcuts', label: '键盘快捷键', icon: Keyboard }),
      Object.freeze({ id: 'usage', label: '使用情况和计费', icon: Gauge }),
      Object.freeze({ id: 'account', label: '账户', icon: Globe }),
    ]),
  }),
  Object.freeze({
    label: '集成',
    entries: Object.freeze([
      Object.freeze({ id: 'computer-control', label: '电脑操控', icon: MonitorCog }),
      Object.freeze({ id: 'snapshots', label: '应用快照', icon: Camera }),
      Object.freeze({ id: 'plugins', label: '插件', icon: Plug }),
      Object.freeze({ id: 'browser', label: '浏览器', icon: Globe }),
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

      <div className="settings-rail__list" role="tablist" aria-label="设置分区">
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