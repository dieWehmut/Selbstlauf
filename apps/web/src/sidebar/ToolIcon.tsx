import { useState } from 'react';
import { Bot, Network, Terminal } from 'lucide-react';

/**
 * Each tool's own icon, shared by every surface that lists a session.
 *
 * The art is the publishers' own, taken from the most faithful source available on this machine:
 *
 *   codex   the running Codex app window's icon, read from the window itself — the genuine OpenAI mark
 *   dsh     the DeepSeek whale, from the harness's own `favicon.svg`
 *   claude  the Anthropic mark from anthropic.com's favicon, because the Claude CLI ships no icon at all (it is
 *           terminal-only) and the desktop app is not installed here
 *
 * A missing asset falls back to a glyph rather than leaving a broken image, so the list stays readable if the
 * files are ever absent — which is worth keeping, because the images are shipped assets and can go missing.
 */
export const TOOL_ICON_SRC: Readonly<Record<string, string>> = Object.freeze({
  codex: 'tool-icons/codex.png',
  claude: 'tool-icons/claude.png',
  dsh: 'tool-icons/dsh.png',
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
        className="tool-icon__image"
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