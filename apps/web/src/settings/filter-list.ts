/** Keep ordinary comma-separated filters readable, quoting values that would not round-trip. */
export function formatFilterList(values: readonly string[]): string {
  return values.map((value) => value.length === 0 || value.trim() !== value || /[",\u0000-\u001f\u007f]/u.test(value)
    ? JSON.stringify(value) : value).join(', ');
}

function isSeparator(value: string): boolean {
  return value === ',' || value === '\r' || value === '\n';
}

/** Accept legacy bare filters and JSON string literals, separated by commas or newlines. */
export function parseFilterList(text: string): string[] {
  const values: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    while (offset < text.length && (isSeparator(text[offset]) || /\s/u.test(text[offset]))) offset += 1;
    if (offset === text.length) break;

    if (text[offset] !== '"') {
      const start = offset;
      while (offset < text.length && !isSeparator(text[offset])) offset += 1;
      const value = text.slice(start, offset).trim();
      if (value.length > 0) values.push(value);
      continue;
    }

    const start = offset;
    let closed = false;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2;
      else if (text[offset] === '"') { offset += 1; closed = true; break; }
      else offset += 1;
    }
    if (!closed) throw new SyntaxError('Invalid quoted filter');
    let value: string;
    try { value = JSON.parse(text.slice(start, offset)) as string; }
    catch { throw new SyntaxError('Invalid quoted filter'); }
    while (offset < text.length && !isSeparator(text[offset]) && /\s/u.test(text[offset])) offset += 1;
    if (offset < text.length && !isSeparator(text[offset])) throw new SyntaxError('Invalid quoted filter');
    values.push(value);
  }
  return values;
}
