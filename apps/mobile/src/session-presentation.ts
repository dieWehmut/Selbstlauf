import type { Session } from "./client";
import { isAdditionalMonitoredTool, monitoringTransportReason } from "../../web/src/session/monitoring-reasons";

export function sessionToolName(tool: string): string {
  return ({ claude: "Claude", codex: "Codex", dsh: "DeepSeek", opencode: "OpenCode",
    gemini: "Gemini CLI", antigravity: "Antigravity", cursor: "Cursor", shell: "Shell" } as Record<string, string>)[tool] ?? tool;
}

/** Activity must come from the tool's own turn state, never from a silence timer. */
export function monitoredSessionState(session: Session): string {
  if (!session.alive) return "已结束";
  if (session.paused) return "已暂停";
  if (isAdditionalMonitoredTool(session.tool) && !session.enabled) return "监控已关闭";
  if (session.runningTurn === true) return "运行中";
  if (session.runningTurn === false) return "空闲";
  return isAdditionalMonitoredTool(session.tool) ? "状态未知" : session.enabled ? "监控中" : "已禁用";
}

/** Match the desktop's explicit input-channel allowlist. New transports fail closed. */
export function canWriteMonitoredSession(session: Session | null): boolean {
  return session !== null && session.alive && !session.paused
    && ["classic-console", "pty", "codex-app-server", "claude-stop-hook", "dsh-web"].includes(session.transport);
}

export function monitoredSessionWriteHint(session: Session | null): string | null {
  if (session === null || !session.alive) return "该会话已结束，无法发送提示。";
  if (session.paused) return "该会话已暂停，恢复后才能发送提示。";
  if (!canWriteMonitoredSession(session) && session.transportError) {
    const reason = monitoringTransportReason(session.transportError);
    if (reason !== session.transportError) return reason;
  }
  return canWriteMonitoredSession(session) ? null : "当前会话仅支持监控，未提供可验证的输入通道。";
}
