import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every rule in the app's stylesheets has to be reachable from the app's source.
 *
 * Two defects of exactly this shape are in this project's history, and neither was visible to any other test:
 *
 *   - `:root[data-density='compact']` had three rules and a preference behind them, and **nothing set the
 *     attribute** — the rules could never match and there was no control (round 15, wired rather than deleted);
 *   - twelve rules were left behind by interfaces that no longer exist (an old settings tab strip, a sidebar
 *     service card, preset swatches, and a theme-diff arrow), so the stylesheet described a UI that was not
 *     there — the same class of stale description as a section that changes nothing.
 *
 * The check is deliberately about *reachability*, not about tidiness: a rule whose class or attribute the source
 * never names cannot affect anything, and the cheapest time to find that out is now rather than when someone
 * edits a rule that looks live.
 *
 * Two kinds of name are composed by the source rather than written: a modifier built inside a template literal
 * (`theme-card--${theme}`), and a `data-` attribute written through `dataset` (`dataset.density` →
 * `data-density`). Both are derived here rather than listed by hand, so the test does not need updating whenever
 * a new modifier family appears — only when a rule really is unreachable.
 */

/** Vitest runs with the workspace as its working directory, which is `apps/web`. */
const SRC = join(process.cwd(), 'src');
const STYLESHEETS = [join(SRC, 'styles', 'index.css'), join(SRC, 'settings', 'sections.css')];

/**
 * Attributes the browser sets rather than the app.
 *
 * `[hidden]` is the user agent's own attribute — the stylesheet honours it explicitly, and no line of the source
 * needs to name it.
 */
const BROWSER_ATTRIBUTES = new Set(['hidden']);

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/u.test(entry.name)) found.push(full);
    }
  };
  walk(SRC);
  return found;
}

/** `data-density` -> `density`, so a `dataset.density` write counts as naming the attribute. */
function datasetName(attribute: string): string | null {
  if (!attribute.startsWith('data-')) return null;
  return attribute.slice('data-'.length).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
}

describe('stylesheet reachability', () => {
  /**
   * Block comments are stripped before matching: prose that mentions a class ("the sidebar brand block") does not
   * make the rule reachable, and leaving it in hid `.brand` from this check the first time it ran.
   */
  const source = sourceFiles()
    .map((file) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, ''))
    .join('\n');
  const css = STYLESHEETS.map((file) => readFileSync(file, 'utf8')).join('\n');
  // Comments are prose: a class named in one is not a rule.
  const selectors: string[] = [];
  for (const match of css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{/gu)) selectors.push(match[1]);

  /**
   * Class names the source can actually put on an element.
   *
   * Every quoted string, split on whitespace: that covers `className="a b"`, the fixed pieces of a template, a
   * ternary arm like `'theme-diff__pane theme-diff__pane--after'`, and a state class toggled as `' is-pulsing'`.
   * A whole-word search of the file was the first attempt and was fooled by `import brandIcon from
   * './assets/brand.png'`, which made `.brand` look reachable.
   */
  const namedTokens = new Set<string>();
  const add = (value: string) => {
    for (const token of value.split(/\s+/u).filter(Boolean)) if (!token.includes('${')) namedTokens.add(token);
  };
  // 1. `className="a b"`.
  for (const match of source.matchAll(/className="([^"]*)"/gu)) add(match[1]);
  // 2. The fixed pieces of `` className={`a b--${x}`} ``.
  for (const match of source.matchAll(/className=\{`([^`]*)`\}/gu)) add(match[1]);
  // 3. Every quoted string: a ternary arm (`'a a--after'`) or a state class toggled as `' is-pulsing'`.
  for (const match of source.matchAll(/['"]([^'"\n]*)['"]/gu)) add(match[1]);

  const namedInSource = (name: string) => new RegExp(`\\b${name}\\b`, 'u').test(source);

  /** Modifier heads the source composes, e.g. `theme-card--` from `theme-card--${theme}`. */
  const composedPrefixes = new Set<string>();
  for (const match of source.matchAll(/`([^`]*)`/gu)) {
    for (const token of match[1].split(/\s+/u).filter(Boolean)) {
      const at = token.indexOf('${');
      if (at > 0) composedPrefixes.add(token.slice(0, at));
    }
  }

  it('names every class its stylesheets style', () => {
    const unreachable: string[] = [];
    for (const selector of selectors) {
      for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)) {
        const name = match[1];
        if (namedTokens.has(name)) continue;
        if ([...composedPrefixes].some((prefix) => name.startsWith(prefix))) continue;
        unreachable.push(name);
      }
    }

    expect(
      [...new Set(unreachable)].sort(),
      'these classes are styled but never named by the app, so the rules cannot apply',
    ).toEqual([]);
  });

  it('sets every attribute its stylesheets select on', () => {
    const unreachable: string[] = [];
    for (const selector of selectors) {
      // `[attr]`, `[attr='value']` — the attribute name is what has to be reachable.
      for (const match of selector.matchAll(/\[\s*([\w-]+)/gu)) {
        const attribute = match[1];
        if (BROWSER_ATTRIBUTES.has(attribute)) continue;
        if (namedInSource(attribute)) continue;
        const camel = datasetName(attribute);
        if (camel !== null && (namedInSource(camel) || namedInSource(`dataset.${camel}`))) continue;
        unreachable.push(attribute);
      }
    }

    expect(
      [...new Set(unreachable)].sort(),
      'these attributes are selected on but never set, so the rules cannot match',
    ).toEqual([]);
  });

  /**
   * The custom properties, in both directions.
   *
   * `--shadow` and `--mesh-line` were defined in both theme blocks and read by nothing (the rules use
   * `--shadow-soft` / `--shadow-lift`), and a variable read with no definition anywhere computes to nothing
   * unless the read carries a fallback.
   *
   * The amber defect in the same family was found by the colour matrix rather than here, and the reason is worth
   * recording: its three reads *did* carry a fallback (`var(--amber, #e6b65b)`), which is exactly what let an
   * unreadable literal look deliberate to every other check.
   */
  it('reads only custom properties it defines, and defines only ones it reads', () => {
    const defined = new Set<string>();
    for (const match of css.matchAll(/(--[\w-]+)\s*:/gu)) defined.add(match[1]);
    // The palette effect sets the solved colours at runtime, so those are definitions as well.
    for (const match of source.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/gu)) defined.add(match[1]);

    const reads = new Map<string, { readonly fallback: boolean }>();
    for (const file of [...STYLESHEETS, ...sourceFiles()]) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/gu)) {
        const previous = reads.get(match[1]);
        reads.set(match[1], { fallback: (previous?.fallback ?? false) || match[2] === ',' });
      }
    }

    const undefinedReads = [...reads].filter(([name, info]) => !info.fallback && !defined.has(name)).map(([name]) => name);
    const unreadDefinitions = [...defined].filter((name) => !reads.has(name));
    expect(undefinedReads, 'these variables are read without a fallback and defined nowhere').toEqual([]);
    expect(unreadDefinitions, 'these variables are defined and read by nothing').toEqual([]);
  });

  it('finds the rules it is meant to be checking', () => {
    // A guard that silently checks nothing is worse than no guard: if the stylesheets stop being found, or the
    // selector extraction stops matching, this fails instead of passing.
    const classes = new Set([...selectors.join('\n').matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map((match) => match[1]));
    const attributes = new Set([...selectors.join('\n').matchAll(/\[\s*([\w-]+)/gu)].map((match) => match[1]));
    expect(existsSync(STYLESHEETS[0]!), `${STYLESHEETS[0]} was not found from ${process.cwd()}`).toBe(true);
    expect(classes.size, 'no classes were extracted from the stylesheets').toBeGreaterThan(200);
    expect(attributes.size, 'no attribute selectors were extracted').toBeGreaterThan(3);
  });
});