import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import AgentInstallationDetails from "../src/components/AgentInstallationDetails.vue";
import { guidedInstallationHint, missingCommandHint, toolOptionLabel, type CatalogTool } from "../src/agent-installation";

function tool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return { id: "workbuddy", label: "WorkBuddy（国内版）", command: null, available: false, kind: "desktop", ...overrides };
}

async function render(entry: CatalogTool) {
  return renderToString(createSSRApp({ render: () => h(AgentInstallationDetails, { tool: entry }) }));
}

describe("computer agent installation details", () => {
  it("shows the computer's installed application path despite having no CLI", async () => {
    const entry = tool({ installation: { status: "installed", path: "C:\\Users\\han\\WorkBuddy\\WorkBuddy.exe" } });
    const html = await render(entry);
    expect(html).toContain("电脑安装状态");
    expect(html).toContain("已安装");
    expect(html).toContain(entry.installation!.path);
    expect(html).not.toContain("未找到");
    expect(toolOptionLabel(entry)).toContain("电脑已安装");
    expect(guidedInstallationHint(entry)).toContain("请在电脑打开");
    expect(guidedInstallationHint(entry)).not.toContain("先在电脑安装");
  });

  it("shows every detected editor extension even when the CLI is missing", async () => {
    const entry = tool({ id: "cline", kind: "cli", installation: { status: "installed", extensions: [
      { id: "saoudrizwan.claude-dev", path: "C:\\Users\\han\\.vscode\\extensions\\saoudrizwan.claude-dev-1" },
      { id: "saoudrizwan.claude-dev", path: "C:\\Users\\han\\.cursor\\extensions\\saoudrizwan.claude-dev-1" },
    ] } });
    const html = await render(entry);
    for (const extension of entry.installation!.extensions!) {
      expect(html).toContain(extension.id);
      expect(html).toContain(extension.path);
    }
    expect(missingCommandHint(entry)).toContain("启动命令未找到");
    expect(missingCommandHint(entry)).not.toContain("尚未在电脑找到此工具");
  });

  it("distinguishes a completed missing result from an unavailable detection", async () => {
    const missing = tool({ installation: { status: "not-found" } });
    const unknown = tool({ installation: { status: "unknown", reason: "无法完整读取安装目录。" } });
    expect(await render(missing)).toContain("未找到");
    const html = await render(unknown);
    expect(html).toContain("未知");
    expect(html).toContain(unknown.installation!.reason);
    expect(html).not.toContain("未找到");
    expect(guidedInstallationHint(missing)).toContain("先在电脑安装");
    expect(guidedInstallationHint(unknown)).toContain("确认此桌面应用是否已安装");
  });

  it("keeps installation unknown for an older computer response, regardless of launch availability", async () => {
    const entry = tool({ available: true });
    const html = await render(entry);
    expect(html).toContain("未知");
    expect(html).toContain("电脑未返回安装检测结果");
    expect(toolOptionLabel(entry)).toContain("电脑安装状态未知");
    expect(toolOptionLabel(tool({ id: "shell", label: "Shell", kind: "shell", available: true }))).toBe("Shell");
  });
});
