import { useState } from 'react';
import { Bot, Network, Terminal } from 'lucide-react';

/** Shared official provider marks, matching the agent list reference.
 * Legacy assets came from the local Orchester project; new publisher assets are
 * recorded in public/tool-icons/sources.json. Codex is inverted in the dark theme.
 */
export const TOOL_ICON_SRC: Readonly<Record<string, string>> = Object.freeze({
  codex: 'tool-icons/codex.png',
  claude: 'tool-icons/claude.svg',
  dsh: 'tool-icons/dsh.png',
  gemini: 'tool-icons/gemini.png',
  antigravity: 'tool-icons/antigravity.svg',
  cursor: 'tool-icons/cursor.png',
});

/**
 * The icon for one tool.
 *
 * Marked decorative: the tool's name is always adjacent in text, so the image carries no information a screen
 * reader would miss.
 */
export function ToolIcon({ tool, size = 14 }: { readonly tool: string; readonly size?: number }) {
  const [failed, setFailed] = useState(false);
  const source = TOOL_ICON_SRC[tool];
  if (source === undefined || failed) {
    return (
      <span className="tool-icon tool-icon--fallback" aria-hidden="true">
        {tool === 'codex' ? <Terminal size={size} /> : tool === 'dsh' ? <Network size={size} /> : <Bot size={size} />}
      </span>
    );
  }
  return (
    <span className="tool-icon" aria-hidden="true">
      <img
        className={`tool-icon__image tool-icon__image--${tool}`}
        src={source}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
