/** Backend monitoring limitations, shared by the desktop and phone presentation. */
export function monitoringTransportReason(reason: string): string {
  return ({
    'This session supports monitoring; no verified input transport is available': '该会话仅支持监控，尚无可验证的输入通道。',
    'No uniquely associated live conversation was found': '尚未唯一关联到活动会话。',
  } as Readonly<Record<string, string>>)[reason] ?? reason;
}

export function isAdditionalMonitoredTool(tool: string): boolean {
  return ['gemini', 'antigravity', 'cursor'].includes(tool);
}
