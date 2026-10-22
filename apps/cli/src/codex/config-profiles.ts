export interface CodexProfileField {
  readonly key: string;
  readonly value: string;
}

/** A null edit removes the active assignment and parks its old value. */
export interface CodexProfileEdit {
  readonly key: string;
  readonly value: string | null;
}

export interface CodexProfile {
  readonly name: string;
  readonly fields: readonly CodexProfileField[];
}

export interface ApplyProfileResult {
  readonly text: string;
  readonly changes: readonly { key: string; action: 'set' | 'uncommented' | 'added' | 'removed'; value: string | null }[];
}

export interface ConfigSummary {
  readonly active: Readonly<Record<string, string>>;
  readonly commented: Readonly<Record<string, readonly string[]>>;
}

export const EDITABLE_KEYS = [
  'model',
  'review_model',
  'model_reasoning_effort',
  'experimental_bearer_token',
  'base_url',
] as const;

export type EditableKey = (typeof EDITABLE_KEYS)[number];

export function isEditableKey(key: string): key is EditableKey {
  return (EDITABLE_KEYS as readonly string[]).includes(key);
}

export function validateProfileEdits(fields: readonly CodexProfileEdit[]): CodexProfileEdit[] {
  if (!Array.isArray(fields) || fields.length === 0) throw new TypeError('fields must be a non-empty array');
  const keys = new Set<string>();
  return fields.map((field) => {
    if (field === null || typeof field !== 'object' || !isEditableKey(field.key)) {
      throw new TypeError(`unsupported Codex config key "${field?.key}"`);
    }
    if (keys.has(field.key)) throw new TypeError(`duplicate Codex config key "${field.key}"`);
    keys.add(field.key);
    if (field.value !== null && (typeof field.value !== 'string' || field.value.trim().length === 0 || /[\0\r\n]/u.test(field.value))) {
      throw new TypeError(`invalid value for Codex config key "${field.key}"`);
    }
    return { key: field.key, value: field.value };
  });
}

interface Assignment {
  readonly key: string;
  readonly value: string;
  readonly label: string;
  readonly commented: boolean;
}

/** Reports which editable top-level keys are active or parked as comments. */
export function readConfigSummary(text: string): ConfigSummary {
  const active: Record<string, string> = {};
  const commented: Record<string, string[]> = {};
  for (const assignment of scanTopLevelAssignments(text)) {
    if (assignment.commented) {
      (commented[assignment.key] ??= []).push(assignment.value);
    } else {
      active[assignment.key] = assignment.value;
    }
  }
  return { active, commented };
}

/**
 * Applies a profile the same way the file is maintained by hand: when the new
 * value already exists as a parked comment it is activated in place and the
 * previously active assignment is parked again, so switching endpoints never
 * loses the previous one. Unknown values replace the active line; missing keys
 * are appended after the last top-level assignment.
 */
export function applyProfile(text: string, fields: readonly CodexProfileEdit[]): ApplyProfileResult {
  const edits = validateProfileEdits(fields);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith('\n') || text.length === 0;
  const body = text.replace(/\r?\n$/u, '');
  const lines = body.length === 0 ? [] : body.split(/\r?\n/u);
  const changes: { key: string; action: 'set' | 'uncommented' | 'added' | 'removed'; value: string | null }[] = [];

  for (const field of edits) {
    const assignments = topLevelIndexes(lines);
    if (field.value === null) {
      // Comment the source line verbatim: labels, quote style and escapes are
      // preserved. Existing alternatives and nested provider/project settings
      // are untouched, and repeating removal is harmless.
      for (const index of assignments) {
        const assignment = matchAssignment(lines[index]!);
        if (assignment?.key === field.key && !assignment.commented) {
          lines[index] = lines[index]!.replace(/^(\s*)/u, '$1# ');
        }
      }
      changes.push({ key: field.key, action: 'removed', value: null });
      continue;
    }
    const active = assignments.find((index) => {
      const assignment = matchAssignment(lines[index]!);
      return assignment !== null && !assignment.commented && assignment.key === field.key;
    });
    const activeAssignment = active === undefined ? null : matchAssignment(lines[active]!);
    if (activeAssignment !== null && activeAssignment.value === field.value) {
      changes.push({ key: field.key, action: 'set', value: field.value });
      continue;
    }
    const parked = assignments.find((index) => {
      const assignment = matchAssignment(lines[index]!);
      return assignment !== null && assignment.commented && assignment.key === field.key && assignment.value === field.value;
    });
    if (parked !== undefined) {
      lines[parked] = formatAssignment(field.key, field.value);
      if (active !== undefined && activeAssignment !== null) {
        lines[active] = formatComment(activeAssignment, '');
      }
      changes.push({ key: field.key, action: 'uncommented', value: field.value });
      continue;
    }
    if (active !== undefined && activeAssignment !== null) {
      const parkedElsewhere = assignments.some((index) => {
        const assignment = matchAssignment(lines[index]!);
        return assignment !== null && assignment.commented && assignment.key === field.key && assignment.value === activeAssignment.value;
      });
      if (!parkedElsewhere) {
        lines.splice(active + 1, 0, formatComment(activeAssignment, '  '));
      }
      lines[active] = formatAssignment(field.key, field.value);

      changes.push({ key: field.key, action: 'set', value: field.value });
      continue;
    }
    const lastAssignment = assignments.at(-1);
    if (lastAssignment === undefined) {
      lines.push(formatAssignment(field.key, field.value));
    } else {
      lines.splice(lastAssignment + 1, 0, formatAssignment(field.key, field.value));
    }
    changes.push({ key: field.key, action: 'added', value: field.value });
  }

  if (lines.length === 0) return { text, changes };
  const result = lines.join(eol) + (hasTrailingNewline ? eol : '');
  return { text: result, changes };
}

/**
 * Captures the currently active endpoint as a reusable profile. The name is
 * derived from the base_url host so the UI can label switches meaningfully.
 */
export function captureActiveProfile(text: string): CodexProfile {
  const summary = readConfigSummary(text);
  const fields: CodexProfileField[] = [];
  for (const key of EDITABLE_KEYS) {
    const value = summary.active[key];
    if (value !== undefined) fields.push({ key, value });
  }
  return { name: profileName(fields), fields };
}

function profileName(fields: readonly CodexProfileField[]): string {
  const baseUrl = fields.find((field) => field.key === 'base_url')?.value;
  if (baseUrl !== undefined && baseUrl.length > 0) {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  }
  return fields.find((field) => field.key === 'model')?.value ?? 'current';
}

/** Only top-level assignments before the first [section] are managed. */
function topLevelIndexes(lines: readonly string[]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed.startsWith('[')) break;
    if (trimmed.length === 0) continue;
    const assignment = matchAssignment(lines[index]!);
    if (assignment !== null && isEditableKey(assignment.key)) indexes.push(index);
  }
  return indexes;
}

function scanTopLevelAssignments(text: string): Assignment[] {
  const lines = text.split(/\r?\n/u);
  return topLevelIndexes(lines).map((index) => matchAssignment(lines[index]!)!);
}

function matchAssignment(line: string): Assignment | null {
  const trimmed = line.trim();
  const commented = trimmed.startsWith('#');
  const content = commented ? trimmed.replace(/^#+\s*/u, '') : trimmed;
  const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/u.exec(content);
  if (match === null) return null;
  const key = match[1]!;
  const rawValue = match[2]!.trim();
  const valueMatch = /^"((?:[^\\"]|\\.)*)"\s*(?:#\s*(.*))?$/u.exec(rawValue);
  if (valueMatch !== null) {
    let value = valueMatch[1] ?? '';
    try { value = JSON.parse(`"${value}"`) as string; } catch { /* Keep unusual TOML escape sequences literal. */ }
    return { key, value, label: (valueMatch[2] ?? '').trim(), commented };
  }
  const literalMatch = /^'([^']*)'\s*(?:#\s*(.*))?$/u.exec(rawValue);
  if (literalMatch !== null) return { key, value: literalMatch[1] ?? '', label: (literalMatch[2] ?? '').trim(), commented };
  return { key, value: rawValue.replace(/\s+#.*$/u, ''), label: '', commented };
}

function formatAssignment(key: string, value: string): string {
  return `${key} = "${escapeValue(value)}"`;
}

function formatComment(assignment: Assignment, _indent: string): string {
  const label = assignment.label.length > 0 ? ` # ${assignment.label}` : '';
  return `# ${assignment.key} = "${escapeValue(assignment.value)}"${label}`;
}

function escapeValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}
