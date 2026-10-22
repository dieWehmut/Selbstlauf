import { translate, type Locale } from './index';

/** Preserve external diagnostics while translating app-owned error wrappers. */
export function componentError(message: string, locale?: Locale): string {
  const agentRequest = /^智能体服务请求失败（(\d+)）$/u.exec(message);
  if (agentRequest) return translate('智能体服务请求失败（{status}）', { status: agentRequest[1] }, locale);
  const patterns: readonly [RegExp, string, string][] = [
    [/^最多保留 (\d+) 个窗口，请先关闭已结束的窗口。$/u, '最多保留 {count} 个窗口，请先关闭已结束的窗口。', 'count'],
    [/^工作目录不存在或无法访问：(.*)$/u, '工作目录不存在或无法访问：{path}', 'path'],
    [/^找不到命令 (.*)，请安装该工具或填写可执行文件的完整路径。$/u, '找不到命令 {command}，请安装该工具或填写可执行文件的完整路径。', 'command'],
    [/^启动失败：([\s\S]*)$/u, '启动失败：{detail}', 'detail'],
    [/^无法加载本机终端组件：([\s\S]*)$/u, '无法加载本机终端组件：{detail}', 'detail'],
    [/^(\w+) 必须是非空的单行文字。$/u, '{field} 必须是非空的单行文字。', 'field'],
  ];
  for (const [pattern, source, key] of patterns) {
    const match = pattern.exec(message);
    if (match) return translate(source, { [key]: key === 'detail' ? translate(match[1], {}, locale) : match[1] }, locale);
  }
  return translate(message, {}, locale);
}
