# Official agent icons

All displayed agent marks are local publisher assets. `sources.json` records the
official website, repository or installed package, the source URL/path, and the
SHA-256 of every shipped image. The files are retained unchanged. Cline and Roo
use CSS inversion for contrast; Codex uses the publisher's two Windows variants.

The coverage includes every tool linked by the [AgentRouter guides](https://agentrouter.org/docs/):
Claude Code (CLI and VS Code), Codex, Qwen Code, OpenCode, OpenClaw, Hermes, Pi,
Crush, Cline, Roo Code, Kilo Code, Claude Desktop, Trae, ZCode, WorkBuddy and
Craft Agents. Gemini CLI, Antigravity, Cursor, Grok and DeepSeek Harness are also
covered. Claude Desktop and Claude Code share Anthropic's official Claude mark.

WorkBuddy's domestic and international catalog entries share `workbuddy.svg`.
The icons linked by [the Chinese site](https://www.workbuddy.cn/) and
[the international site](https://www.workbuddy.ai/) are byte-identical
(`10ccbc099e7bc3d5ff12c315c4edd7b21386aa7166c1ec19997b3d55010d5c7d`).
Both original official URLs are recorded in the source manifest. The editions
have separate official installation and documentation links.

The shared file registry in `src/sidebar/tool-icon-files.ts` supplies WebUI and
Android. WebUI resolves URLs against Vite's configured base; Android bundles the
same files, including in an APK without a network connection. Unknown/custom
commands retain a generic terminal/tool glyph.

Roo Code uses the mark from `RooCodeInc/Roo-Code`, because `roocode.com` currently
redirects to Roomote. Craft Agents uses its own Electron app mark from
`lukilabs/craft-agents-oss`, because `agents.craft.do` currently redirects to Craft
Docs. The redirects do not establish the identity of either agent's icon.

Codex marks were read from the installed `OpenAI.Codex` package version
`26.1103.7773.0`. Claude's mark was retrieved from Anthropic's published
`anthropic.claude-code` Visual Studio Marketplace icon endpoint. The original
Cursor PNG comes from the installed Cursor `3.29.15` resources.

Qwen Code, OpenClaw, Roo Code, Crush and Craft Agents repository licenses are
retained beside their marks. The marks identify the publishers' products.
