import { useState } from 'react';
import { Bot, Network, Terminal } from 'lucide-react';
import { TOOL_ICON_DARK_FILES, TOOL_ICON_FILES } from './tool-icon-files';
import './tool-icons.css';

/** Base-aware local URLs also work in the hosted demo and independent windows. */
const iconUrl = (file: string) => `${import.meta.env.BASE_URL}tool-icons/${file}`;
export const TOOL_ICON_SRC: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(TOOL_ICON_FILES).map(([tool, file]) => [tool, iconUrl(file)])),
);

/**
 * The icon for one tool.
 *
 * Marked decorative: the tool's name is always adjacent in text, so the image carries no information a screen
 * reader would miss.
 */
export function ToolIcon({ tool, size = 14 }: { readonly tool: string; readonly size?: number }) {
  const source = Object.hasOwn(TOOL_ICON_SRC, tool) ? TOOL_ICON_SRC[tool] : undefined;
  const darkFile = Object.hasOwn(TOOL_ICON_DARK_FILES, tool) ? TOOL_ICON_DARK_FILES[tool] : undefined;
  return <ProviderIcon key={`${tool}:${source}`} tool={tool} size={size} source={source} darkSource={darkFile ? iconUrl(darkFile) : undefined} />;
}

function ProviderIcon({ tool, size, source, darkSource }: {
  readonly tool: string; readonly size: number; readonly source?: string; readonly darkSource?: string;
}) {
  const [failed, setFailed] = useState(false);
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
        className={`tool-icon__image tool-icon__image--${tool}${darkSource ? ' tool-icon__image--light' : ''}`}
        src={source}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
      />
      {darkSource && <img className="tool-icon__image tool-icon__image--dark" src={darkSource} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />}
    </span>
  );
}
