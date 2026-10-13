/**
 * The desktop shell's refusal reasons, said in words.
 *
 * The shell reports machine codes — `empty-text`, `multi-line-text`, `invalid-window-handle`,
 * `windowType is not wired up` — and the two panels printed whichever arrived verbatim, so a Chinese panel
 * explained a refusal in the shell's own vocabulary. The same shell writes Chinese in the refusals it raises in
 * its own main process (服务未在运行, 该会话已不在运行, 该会话没有可写入的窗口); these are the rest.
 *
 * Anything unmapped is passed through unchanged. A reason raised by a helper process or an OS call is still the
 * most useful thing to show, and inventing a phrase for it would hide what actually failed — the same rule the
 * service's transport reasons follow.
 */
const REASONS: Readonly<Record<string, string>> = Object.freeze({
  // 窗口预览
  'this build cannot capture windows': '这个版本不能预览窗口',
  'windowPreview is not wired up': '这个版本不能预览窗口',
  'windowPreview needs a session id': '缺少会话标识，无法预览窗口',
  'that session is no longer running': '该会话已不在运行',
  // 模拟键盘写入
  'windowType is not wired up': '这个版本不能写入窗口',
  'windowType needs a session id': '缺少会话标识，无法写入窗口',
  'windowType needs text to type': '没有可写入的内容',
  'empty-text': '没有可写入的内容',
  'multi-line-text': '只能写入一行',
  'text-too-long': '写入内容过长',
  'invalid-window-handle': '窗口句柄无效',
  'unreadable-response': '窗口助手没有返回可读结果',
});

/**
 * Reasons that name the failing step and then carry its own message.
 *
 * The step is translated; the message after it is not, because it comes from the helper or the OS and is the only
 * description of what actually went wrong.
 */
const PREFIXES: readonly { readonly prefix: string; readonly label: string }[] = [
  { prefix: 'could not list sessions: ', label: '无法读取会话列表' },
  { prefix: 'type-command-failed: ', label: '写入命令失败' },
];

export function describeShellReason(reason: string): string {
  const known = REASONS[reason];
  if (known !== undefined) return known;
  for (const { prefix, label } of PREFIXES) {
    if (reason.startsWith(prefix)) return `${label}：${reason.slice(prefix.length)}`;
  }
  return reason;
}