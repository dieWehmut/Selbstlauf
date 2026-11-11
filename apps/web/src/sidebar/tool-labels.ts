/** Publisher names shared by desktop and mobile, independent of either UI framework. */
export const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  codex: 'Codex', claude: 'Claude Code', dsh: 'DeepSeek Harness', gemini: 'Gemini CLI',
  antigravity: 'Antigravity', cursor: 'Cursor', opencode: 'OpenCode', qwen: 'Qwen Code',
  openclaw: 'OpenClaw', hermes: 'Hermes Agent', pi: 'Pi', crush: 'Crush', cline: 'Cline',
  roo: 'Roo Code', kilo: 'Kilo Code', 'claude-app': 'Claude', trae: 'Trae', zcode: 'Z Code',
  workbuddy: 'WorkBuddy', 'craft-agents': 'Craft Agents', grok: 'Grok Build',
});

export function toolLabel(tool: string): string {
  return Object.hasOwn(TOOL_LABELS, tool) ? TOOL_LABELS[tool] : tool;
}
