import { useEffect, useState } from 'react';
import type { WatchdogConfig } from '../api/client';

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Rebase saved changes field by field, retaining only values the user edited. */
function merge(previous: unknown, local: unknown, saved: unknown): unknown {
  if (equal(previous, local)) return structuredClone(saved);
  if (previous !== null && local !== null && saved !== null
    && typeof previous === 'object' && typeof local === 'object' && typeof saved === 'object'
    && !Array.isArray(previous) && !Array.isArray(local) && !Array.isArray(saved)) {
    const before = previous as Record<string, unknown>;
    const draft = local as Record<string, unknown>;
    const incoming = saved as Record<string, unknown>;
    return Object.fromEntries([...new Set([...Object.keys(incoming), ...Object.keys(draft)])]
      .map((key) => [key, merge(before[key], draft[key], incoming[key])]));
  }
  return structuredClone(local);
}

interface Editor {
  baseline: WatchdogConfig;
  draft: WatchdogConfig;
  includeFilters: string;
  excludeFilters: string;
}

function rebase(editor: Editor, saved: WatchdogConfig, baseline = editor.baseline,
  includeBaseline = baseline.processFilters.include.join(', '), excludeBaseline = baseline.processFilters.exclude.join(', ')): Editor {
  return {
    baseline: structuredClone(saved),
    draft: merge(baseline, editor.draft, saved) as WatchdogConfig,
    includeFilters: editor.includeFilters === includeBaseline ? saved.processFilters.include.join(', ') : editor.includeFilters,
    excludeFilters: editor.excludeFilters === excludeBaseline ? saved.processFilters.exclude.join(', ') : editor.excludeFilters,
  };
}

/** Keep one editor alive across settings sections and acknowledge only successful saves. */
export function useConfigDraft(saved: WatchdogConfig) {
  const [editor, setEditor] = useState<Editor>(() => ({ baseline: structuredClone(saved), draft: structuredClone(saved),
    includeFilters: saved.processFilters.include.join(', '), excludeFilters: saved.processFilters.exclude.join(', ') }));
  useEffect(() => { setEditor((current) => rebase(current, saved)); }, [saved]);
  return {
    ...editor,
    setDraft: (draft: WatchdogConfig) => setEditor((current) => ({ ...current, draft })),
    setIncludeFilters: (includeFilters: string) => setEditor((current) => ({ ...current, includeFilters })),
    setExcludeFilters: (excludeFilters: string) => setEditor((current) => ({ ...current, excludeFilters })),
    acknowledge: (confirmed: WatchdogConfig) => {
      // The closure captures the submitted editor. A later edit made while its
      // request was pending still wins over the confirmed response.
      setEditor((current) => rebase(current, confirmed, editor.draft, editor.includeFilters, editor.excludeFilters));
    },
  };
}
