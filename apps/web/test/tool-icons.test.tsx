import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolIcon, TOOL_ICON_SRC } from '../src/sidebar/ToolIcon';
import { TOOL_ICON_DARK_FILES, TOOL_ICON_FILES } from '../src/sidebar/tool-icon-files';

// Independent coverage inventory from AgentRouter's guides and existing tools.
const providers = ['claude', 'claude-app', 'codex', 'qwen', 'opencode', 'openclaw', 'hermes',
  'pi', 'crush', 'cline', 'roo', 'kilo', 'trae', 'zcode', 'workbuddy', 'workbuddy-intl', 'craft-agents',
  'gemini', 'antigravity', 'cursor', 'grok', 'dsh'];

describe('official tool icons', () => {
  it('renders a publisher mark for every documented and existing agent', () => {
    const { container } = render(<>{providers.map((tool) => <ToolIcon key={tool} tool={tool} />)}</>);
    expect(container.querySelectorAll('.tool-icon--fallback')).toHaveLength(0);
    for (const image of container.querySelectorAll('img')) {
      expect(image.getAttribute('alt')).toBe('');
      expect(image.getAttribute('src')).toMatch(/^\/tool-icons\/[^/]+\.(png|svg|ico)$/u);
    }
  });

  it('matches all displayed images to the publisher-source manifest and shipped bytes', () => {
    const directory = resolve(process.cwd(), 'public/tool-icons');
    const manifest = JSON.parse(readFileSync(resolve(directory, 'sources.json'), 'utf8')) as Record<string, { source: string; product: string; sha256: string }>;
    const files = new Set([...Object.values(TOOL_ICON_FILES), ...Object.values(TOOL_ICON_DARK_FILES)]);
    for (const file of files) {
      expect(manifest[file]?.source, file).toBeTruthy();
      expect(manifest[file]?.product, file).toBeTruthy();
      const bytes = readFileSync(resolve(directory, file));
      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(manifest[file]!.sha256);
    }
  });

  it('recovers when a different launcher selection follows a failed icon', () => {
    const { container, rerender } = render(<ToolIcon tool="codex" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('.tool-icon--fallback')).not.toBeNull();
    rerender(<ToolIcon tool="opencode" />);
    expect(container.querySelector('.tool-icon--fallback')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(TOOL_ICON_SRC.opencode);
  });

  it('keeps unknown commands and inherited object names on the generic fallback', () => {
    const { container } = render(<><ToolIcon tool="custom" /><ToolIcon tool="toString" /><ToolIcon tool="__proto__" /></>);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('.tool-icon--fallback')).toHaveLength(3);
  });
});
