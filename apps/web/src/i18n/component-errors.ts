import { translate, type Locale } from './index';

/** Preserve external diagnostics while translating app-owned error wrappers. */
export function componentError(message: string, locale?: Locale): string {
  const agentRequest = /^智能体服务请求失败（(\d+)）$/u.exec(message);
  if (agentRequest) return translate('智能体服务请求失败（{status}）', { status: agentRequest[1] }, locale);
  return translate(message, {}, locale);
}
