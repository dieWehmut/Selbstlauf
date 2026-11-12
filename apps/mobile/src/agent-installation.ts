import type { AgentCatalog } from "./client";

export type CatalogTool = AgentCatalog["tools"][number];

export function installationLabel(tool: CatalogTool): "已安装" | "未找到" | "未知" {
  if (tool.installation?.status === "installed") return "已安装";
  if (tool.installation?.status === "not-found") return "未找到";
  return "未知";
}

export function toolOptionLabel(tool: CatalogTool): string {
  const kind = tool.kind === "desktop" ? "（桌面应用）" : tool.kind === "extension" ? "（编辑器扩展）" : "";
  const label = installationLabel(tool);
  const status = tool.id === "shell" || tool.id === "custom" ? "" : ` · 电脑${label === "未知" ? "安装状态未知" : label}`;
  return `${tool.label}${kind}${status}`;
}

export function guidedInstallationHint(tool: CatalogTool): string {
  const product = tool.kind === "extension" ? "编辑器扩展" : "桌面应用";
  if (tool.installation?.status === "installed") {
    return `已在电脑检测到此${product}，请在电脑${tool.kind === "extension" ? "编辑器中打开" : "打开"}，然后按接入指南配置模型。`;
  }
  if (tool.installation?.status === "not-found") {
    return `尚未在电脑找到此${product}，请先在电脑安装并打开，然后按接入指南配置模型。`;
  }
  return `电脑安装状态未知，请先在电脑确认此${product}是否已安装，再打开并按接入指南配置模型。`;
}

export function missingCommandHint(tool: CatalogTool): string {
  if (tool.installation?.status === "not-found") return "尚未在电脑找到此工具，请先在电脑安装。";
  return "电脑上的启动命令未找到，请在电脑检查 CLI 安装和 PATH。";
}
