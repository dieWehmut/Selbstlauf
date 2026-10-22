import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { appMessages } from '../src/i18n/app-messages';
import { componentMessages } from '../src/i18n/component-messages';
import { messages } from '../src/i18n';

const sourceRoot = resolve('src');
const parameters = (value: string) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map((match) => match[1]).sort();
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((item) => item.isDirectory()
    ? files(join(root, item.name)) : /\.tsx?$/u.test(item.name) ? [join(root, item.name)] : []);
}

describe('translation catalog integrity', () => {
  it('provides all three translated messages with the same parameter names as the source', () => {
    const failures: string[] = [];
    for (const [source, entry] of Object.entries(messages)) {
      for (const [locale, translated] of Object.entries(entry)) {
        if (!translated.trim()) failures.push(`${locale}: empty ${source}`);
        if (JSON.stringify(parameters(translated)) !== JSON.stringify(parameters(source))) failures.push(`${locale}: parameters in ${source}`);
      }
      if (Object.keys(entry).sort().join(',') !== 'en,ja,zhTW') failures.push(`Missing language: ${source}`);
    }
    expect(failures).toEqual([]);
  });
  it('keeps shared App and component messages consistent', () => {
    const conflicts = Object.keys(appMessages).filter((key) => componentMessages[key] !== undefined
      && JSON.stringify(appMessages[key]) !== JSON.stringify(componentMessages[key]));
    expect(conflicts).toEqual([]);
  });
  it('covers every literal translation call in application source', () => {
    const missing: string[] = [];
    for (const file of files(sourceRoot)) {
      if (file.includes(`${join('src', 'i18n')}/`)) continue;
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t', 'translate'].includes(node.expression.text)) {
          const key = node.arguments[0];
          if (key && ts.isStringLiteralLike(key) && messages[key.text] === undefined) {
            const position = source.getLineAndCharacterOfPosition(key.getStart());
            missing.push(`${file.slice(sourceRoot.length + 1)}:${position.line + 1} ${key.text}`);
          }
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'message') {
          const key = node.arguments[0];
          if (key && ts.isStringLiteralLike(key) && messages[key.text] === undefined) {
            const position = source.getLineAndCharacterOfPosition(key.getStart());
            missing.push(`${file.slice(sourceRoot.length + 1)}:${position.line + 1} ${key.text}`);
          }
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'LocalizedError') {
          const key = node.arguments?.[0];
          if (key && ts.isStringLiteralLike(key) && messages[key.text] === undefined) {
            const position = source.getLineAndCharacterOfPosition(key.getStart());
            missing.push(`${file.slice(sourceRoot.length + 1)}:${position.line + 1} ${key.text}`);
          }
        }
        if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === 'FormattedMessage') {
          const attribute = node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(source) === 'source');
          if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isStringLiteral(attribute.initializer)
            && messages[attribute.initializer.text] === undefined) {
            const position = source.getLineAndCharacterOfPosition(attribute.getStart());
            missing.push(`${file.slice(sourceRoot.length + 1)}:${position.line + 1} ${attribute.initializer.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(missing).toEqual([]);
  });
});
