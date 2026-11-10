const REASONS: Readonly<Record<string, string>> = {
  'association-required': '尚未唯一关联到这一个进程的对话。关联成功后会显示真实输出。',
  'transcript-missing': '暂未找到该会话的记录。智能体写入会话记录后会自动显示。',
  'transcript-unreadable': '当前无法读取该会话的记录。',
  'transcript-invalid': '会话记录正在写入或暂时无法解析，请稍后刷新。',
  'projection-too-large': '该会话记录过大，请在智能体的原窗口中查看。',
  'transcript-too-large': '该会话记录过大，请在智能体的原窗口中查看。',
  'projection-format-unsupported': '当前智能体版本未提供可读取的会话输出。',
  'transcript-format-unsupported': '当前版本的会话记录格式暂不支持解析。',
  'composer-transcript-unavailable': 'Cursor 未提供可读取的对话消息，暂仅显示会话状态。',
  'host-transcript-unavailable': '本机未导出可读取的会话正文，暂仅显示会话状态。',
  'conversation-summary-only': '该会话只提供标题和活动摘要，暂无可读取的对话消息。',
};

/** The desktop and phone explain unavailable outputs in the same words. */
export function sessionOutputReason(reason?: string): string {
  return REASONS[reason ?? ''] ?? '暂时无法读取该会话的输出。';
}
