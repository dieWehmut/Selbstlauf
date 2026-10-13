import type { AuditEvent } from '../api/client';

/**
 * An audit event's `details` payload, said in words.
 *
 * The timeline rendered `Object.values(event.details).join(' · ')`: values only, no keys, nothing translated.
 * Lines read `awaiting-quiet-period`, or `1789000000000` for a decision event's `atMs`, and a reader could not
 * tell which field a value belonged to — while the chip directly above each line translated the event's type.
 *
 * This module owns the shape and the vocabularies that live here (actions, sources, tools, booleans, the
 * timestamp), and takes the two that already have an owner — the engine's decisions, and its transport reasons
 * — as functions, so neither vocabulary is duplicated. Anything unmapped is printed under its own key rather
 * than dropped: a payload this build has never seen stays legible instead of vanishing.
 */
export interface AuditDetailLabels {
  /** Only the caller knows how this app writes a time, so `atMs` is formatted through it. */
  readonly time: (timestampMs: number) => string;
  /** The engine's decision vocabulary; the same labels the status chip uses. */
  readonly decision: (decision: string) => string;
  /** The engine's transport-reason vocabulary, which the capability badge already translates. */
  readonly reason: (reason: string) => string;
}

/** The payload's known keys, named. A key that is not here is printed as itself. */
const KEY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  action: '操作',
  reason: '原因',
  decision: '决策',
  source: '来源',
  tool: '工具',
  ok: '结果',
  dryRun: 'Dry Run',
  succeeded: '成功数',
  keys: '字段',
  installed: '已安装',
  enabled: '已启用',
  restartRequired: '需重启',
  manualReviewRequired: '需人工检查',
  atMs: '时间',
});

/** The action codes the engine and the service emit, from the call sites that write them. */
const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'pause': '暂停',
  'resume': '恢复',
  'manual-inject': '手动续写',
  'automatic-inject': '自动续写',
  'watchdog-start': '启动 Watchdog',
  'watchdog-stop': '停止 Watchdog',
  'install': '安装 Watchdog',
  'uninstall': '卸载 Watchdog',
  'environment-refresh': '刷新本地环境',
  'environment-upgrade': '升级工具',
  'environment-upgrade-all': '升级全部工具',
  'codex-profile-apply': '切换 Codex 端点',
  'startup-install': '加入开机启动',
  'startup-uninstall': '移出开机启动',
  'focus': '打开运行位置',
  'claude-hook-install': '安装 Stop Hook',
  'claude-hook-uninstall': '卸载 Stop Hook',
  'claude-hook-disable': '停用 Stop Hook',
});

/** Where an activity event's fingerprint came from. */
const SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'claude-jsonl': 'Claude 记录',
  'codex-rollout': 'Codex 记录',
  'dsh-session': 'Harness 会话',
});

const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  codex: 'Codex',
  claude: 'Claude',
  dsh: 'DeepSeek Harness',
});

/** A single value, or null when there is nothing worth saying. */
function detailValue(key: string, value: string | number | boolean, labels: AuditDetailLabels): string | null {
  if (key === 'atMs' && typeof value === 'number') return labels.time(value);
  if (typeof value === 'boolean') {
    // `ok` is a verdict rather than a flag, so it gets a verdict's words.
    if (key === 'ok') return value ? '成功' : '失败';
    return value ? '是' : '否';
  }
  if (typeof value === 'number') return String(value);
  switch (key) {
    case 'action': return ACTION_LABELS[value] ?? value;
    case 'source': return SOURCE_LABELS[value] ?? value;
    case 'tool': return TOOL_LABELS[value] ?? value;
    case 'decision': return labels.decision(value);
    case 'reason': return labels.reason(value);
    default: return value;
  }
}

/**
 * Renders the payload as `label: value` pairs.
 *
 * A `null` value says nothing: the engine writes nulls for "no reason", and `原因：null` would be words spent
 * on an absence. Everything else is kept, including keys this build does not know.
 */
export function describeAuditDetails(
  details: AuditEvent['details'],
  labels: AuditDetailLabels,
): string {
  if (details === undefined) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(details)) {
    if (raw === null) continue;
    const value = detailValue(key, raw, labels);
    if (value === null) continue;
    parts.push(`${KEY_LABELS[key] ?? key}：${value}`);
  }
  return parts.join(' · ');
}