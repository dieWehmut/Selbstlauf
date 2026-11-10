import { describe, expect, it } from "vitest";
import type { Session } from "../src/client";
import { canWriteMonitoredSession, monitoredSessionState, monitoredSessionWriteHint, sessionToolName } from "../src/session-presentation";

function session(overrides: Partial<Session> = {}): Session {
  return { id: "gemini:1", tool: "gemini", rootPid: 1, childPids: [], conversationId: null,
    goal: null, transport: "monitor-only", alive: true, enabled: true, paused: false,
    startedAtMs: 0, lastActivityAtMs: 1, quietForMs: 3_600_000, ...overrides };
}

describe("monitored session presentation", () => {
  it.each(["gemini", "antigravity", "cursor"] as const)("shows %s status only when the source reports it", (tool) => {
    expect(monitoredSessionState(session({ tool }))).toBe("状态未知");
    expect(monitoredSessionState(session({ tool, runningTurn: true }))).toBe("运行中");
    expect(monitoredSessionState(session({ tool, runningTurn: false }))).toBe("空闲");
    expect(monitoredSessionState(session({ tool, alive: false, runningTurn: true }))).toBe("已结束");
    expect(monitoredSessionState(session({ tool, enabled: false }))).toBe("监控已关闭");
    expect(monitoredSessionState(session({ tool, paused: true, runningTurn: true }))).toBe("已暂停");
  });

  it("uses each application's name", () => {
    expect(sessionToolName("gemini")).toBe("Gemini CLI");
    expect(sessionToolName("antigravity")).toBe("Antigravity");
    expect(sessionToolName("cursor")).toBe("Cursor");
    expect(sessionToolName("new-tool")).toBe("new-tool");
  });

  it("offers manual input only for an available explicit transport", () => {
    expect(canWriteMonitoredSession(session())).toBe(false);
    expect(canWriteMonitoredSession(session({ transport: "future-transport" }))).toBe(false);
    expect(canWriteMonitoredSession(null)).toBe(false);
    expect(canWriteMonitoredSession(session({ transport: "classic-console", enabled: false }))).toBe(true);
    expect(canWriteMonitoredSession(session({ transport: "pty", paused: true }))).toBe(false);
    expect(canWriteMonitoredSession(session({ transport: "pty", alive: false }))).toBe(false);
    expect(monitoredSessionWriteHint(session())).toContain("仅支持监控");
    expect(monitoredSessionWriteHint(session({ transport: "pty", paused: true }))).toContain("恢复后");
    expect(monitoredSessionWriteHint(session({ transport: "pty" }))).toBeNull();
    expect(monitoredSessionWriteHint(session({ transportError: "No uniquely associated live conversation was found" }))).toBe("尚未唯一关联到活动会话。");
    expect(monitoredSessionWriteHint(session({ transportError: "This session supports monitoring; no verified input transport is available" }))).toBe("该会话仅支持监控，尚无可验证的输入通道。");
  });
});
