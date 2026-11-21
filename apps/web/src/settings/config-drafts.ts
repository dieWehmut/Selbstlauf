import { useEffect, useState } from 'react';
import type { WatchdogConfig } from '../api/client';
import { formatFilterList } from './filter-list';

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
  includeBaseline = formatFilterList(baseline.processFilters.include), excludeBaseline = formatFilterList(baseline.processFilters.exclude)): Editor {
  return {
    baseline: structuredClone(saved),
    draft: merge(baseline, editor.draft, saved) as WatchdogConfig,
    includeFilters: editor.includeFilters === includeBaseline ? formatFilterList(saved.processFilters.include) : editor.includeFilters,
    excludeFilters: editor.excludeFilters === excludeBaseline ? formatFilterList(saved.processFilters.exclude) : editor.excludeFilters,
  };
}

/** Keep one editor alive across settings sections and acknowledge only successful saves. */
export function useConfigDraft(saved: WatchdogConfig) {
  const [editor, setEditor] = useState<Editor>(() => ({ baseline: structuredClone(saved), draft: structuredClone(saved),
    includeFilters: formatFilterList(saved.processFilters.include), excludeFilters: formatFilterList(saved.processFilters.exclude) }));
  useEffect(() => { setEditor((current) => rebase(current, saved)); }, [saved]);
  return {
    ...editor,
    setDraft: (draft: WatchdogConfig) => setEditor((current) => ({ ...current, draft })),
    setIncludeFilters: (includeFilters: string) => setEditor((current) => ({ ...current, includeFilters })),
    setExcludeFilters: (excludeFilters: string) => setEditor((current) => ({ ...current, excludeFilters })),
    replaceSince: (confirmed: WatchdogConfig, previousDraft: WatchdogConfig,
      previousIncludeFilters: string, previousExcludeFilters: string) => setEditor((current) => ({
      baseline: structuredClone(confirmed),
      draft: merge(previousDraft, current.draft, confirmed) as WatchdogConfig,
      includeFilters: current.includeFilters === previousIncludeFilters
        ? formatFilterList(confirmed.processFilters.include) : current.includeFilters,
      excludeFilters: current.excludeFilters === previousExcludeFilters
        ? formatFilterList(confirmed.processFilters.exclude) : current.excludeFilters,
    })),
    acknowledge: (confirmed: WatchdogConfig) => {
      // The closure captures the submitted editor. A later edit made while its
      // request was pending still wins over the confirmed response.
      setEditor((current) => rebase(current, confirmed, editor.draft, editor.includeFilters, editor.excludeFilters));
    },
  };
}
