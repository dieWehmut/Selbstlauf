import { describe, expect, it } from 'vitest';
import { formatFilterList, parseFilterList } from '../src/settings/filter-list';

describe('process filter text', () => {
  it('keeps ordinary comma-separated filters readable', () => {
    expect(formatFilterList(['Nexus', 'study-os', 'C:\\work\\repo'])).toBe('Nexus, study-os, C:\\work\\repo');
    expect(parseFilterList(' Nexus,, study-os\r\n C:\\work\\repo, ')).toEqual(['Nexus', 'study-os', 'C:\\work\\repo']);
    expect(parseFilterList('project "demo", next')).toEqual(['project "demo"', 'next']);
  });

  it.each([
    { values: [] },
    { values: ['Acme, Inc', 'say "go"', 'C:\\Work, Inc\\repo'] },
    { values: ['', ' ', ' padded ', '\tleading', 'trailing\n'] },
    { values: ['two\nlines', 'carriage\rreturn', 'a\u0000b', 'a\u007fb'] },
    { values: ['项目', '🚀,任务', 'project "demo"', '"starts with quote', '\\'] },
  ])('preserves every value across formatting and parsing: $values', ({ values }) => {
    expect(parseFilterList(formatFilterList(values))).toEqual(values);
    expect(formatFilterList(values)).not.toMatch(/[\r\n]/u);
  });

  it('accepts quoted and bare fields together without losing an explicit empty filter', () => {
    expect(parseFilterList(' Nexus, "Acme, Inc", "say \\"go\\"", "", study-os '))
      .toEqual(['Nexus', 'Acme, Inc', 'say "go"', '', 'study-os']);
    expect(parseFilterList('')).toEqual([]);
    expect(parseFilterList('""')).toEqual(['']);
  });

  it.each(['"Acme, Inc', '"bad\\x"', '"closed"suffix', '"one" "two"', '"raw\nnewline"', '"trailing\\'])
    ('rejects malformed quoted filters instead of splitting them: %s', (value) => {
      expect(() => parseFilterList(value)).toThrow(SyntaxError);
    });
});
