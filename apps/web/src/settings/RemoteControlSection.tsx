import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Smartphone } from 'lucide-react';
import type { RemoteControlView, WatchdogApi } from '../api/client';
import { useI18n } from '../i18n';
import './remote-control.css';

export function RemoteControlSection(props: {
  readonly api: Pick<WatchdogApi, 'remote' | 'refreshRemotePairing' | 'revokeRemoteDevice' | 'enableRemote' | 'disableRemote'>;
  readonly demo?: boolean;
}) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<RemoteControlView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(48921);
  const [name, setName] = useState('Selbstlauf');
  const [customBind, setCustomBind] = useState(false);
  const working = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    if (props.demo || !props.api.remote) return;
    let active = true;
    let initialized = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!working.current) {
        const version = generation.current;
        try {
          const next = await props.api.remote!();
          if (active && version === generation.current) {
            setView(next); setError('');
            if (!initialized) {
              setHost(next.host); setPort(next.port); setName(next.name);
              setCustomBind(!['127.0.0.1', '0.0.0.0'].includes(next.host));
              initialized = true;
            }
          }
        } catch (cause) {
          if (active && version === generation.current) {
            setView(null);
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      }
      if (active) timer = setTimeout(() => void poll(), 3_000);
    };
    void poll();
    return () => { active = false; generation.current += 1; clearTimeout(timer); };
  }, [props.api, props.demo]);

  const act = async (work: (() => Promise<RemoteControlView>) | undefined) => {
    if (!work || working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    const version = ++generation.current;
    try {
      const next = await work();
      if (version === generation.current) setView(next);
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.current = false;
      if (version === generation.current) setBusy(false);
    }
  };
  const date = (value: number) => new Date(value).toLocaleString(locale);
  const expired = view?.enabled && view.pairing.expiresAtMs <= Date.now();

  return <section className="settings-section settings-section--wide remote-control">
    <div className="section-title"><div><span className="eyebrow">Android</span><h2>{t('手机远控')}</h2></div><Smartphone size={20} /></div>
    <p className="section-hint">{t('在手机上输入电脑地址与一次性配对码，即可管理会话和智能体。')}</p>
    {props.demo ? <p role="note">{t('演示模式不提供手机配对。')}</p>
      : !props.api.remote ? <p role="status">{t('当前电脑服务不支持手机远控，请更新后重试。')}</p>
      : view === null && !error ? <p role="status">{t('正在读取远控状态…')}</p>
      : view?.enabled === false && <p>{t('手机远控尚未启用。选择连接范围后启用，可连接正在使用的电脑服务。')}</p>}
    {!props.demo && props.api.remote && view !== null && <>
      <div className="field-grid remote-control__fields">
        <label><span>{t('连接范围')}</span><select aria-label={t('连接范围')} value={customBind ? 'custom' : host} disabled={busy} onChange={(event) => {
          setCustomBind(event.target.value === 'custom');
          setHost(event.target.value === 'custom' ? '' : event.target.value);
        }}><option value="127.0.0.1">{t('仅本机（模拟器或隧道）')}</option><option value="0.0.0.0">{t('局域网 / VPN')}</option><option value="custom">{t('指定监听 IP')}</option></select></label>
        {customBind && <label><span>{t('指定监听 IP')}</span><input aria-label={t('指定监听 IP')} value={host} disabled={busy} onChange={(event) => setHost(event.target.value)} /></label>}
        <label><span>{t('远控端口')}</span><input aria-label={t('远控端口')} type="number" min={1} max={65535} value={port} disabled={busy} onChange={(event) => setPort(Number(event.target.value))} /></label>
        <label><span>{t('电脑名称')}</span><input aria-label={t('电脑名称')} maxLength={80} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      </div>
      {host !== '127.0.0.1' && <p className="section-hint">{t('仅在可信局域网或 VPN 中使用，并允许手机访问所选端口。')}</p>}
      <div className="settings-actions">
        <button className="button button--primary" type="button" disabled={busy || !props.api.enableRemote || !host.trim() || !name.trim() || !Number.isInteger(port) || port < 1 || port > 65535} onClick={() => void act(() => props.api.enableRemote!({ host: host.trim(), port, name: name.trim() }))}>{view.enabled ? t('应用连接设置') : t('启用手机远控')}</button>
        {view.enabled && <button className="button button--danger" type="button" disabled={busy || !props.api.disableRemote} onClick={() => void act(props.api.disableRemote)}>{t('关闭手机远控')}</button>}
      </div>
      {!view.enabled && view.error && <p role="alert">{t('远控管理失败：{detail}', { detail: view.error })}</p>}
    </>}
    {!props.demo && view?.enabled && <>
        <div className="switch-row"><div><strong>{t('网关地址')}</strong><span>{t('监听地址为 0.0.0.0 时，请在手机输入电脑的局域网 IP。')}</span></div><code>{view.url}</code></div>
        <div className="remote-control__pairing">
          <div><strong>{t('一次性配对码')}</strong><p className="remote-control__code">{expired ? t('配对码已过期') : view.pairing.code}</p><span>{t('有效期至 {time}', { time: date(view.pairing.expiresAtMs) })}</span></div>
          <button className="button button--secondary" type="button" disabled={busy || !props.api.refreshRemotePairing} onClick={() => void act(props.api.refreshRemotePairing)}><RefreshCw size={16} />{t('生成新配对码')}</button>
        </div>
        <p className="section-hint">{t('配对码使用一次后自动更换。生成新码不会中断电脑任务或已配对手机。')}</p>
        <h3>{t('已配对手机')}</h3>
        {view.devices.length === 0 ? <p>{t('暂无已配对手机。')}</p> : view.devices.map((device) => <div className="switch-row" key={device.id}>
          <div><strong>{device.name}</strong><span>{t('有效期至 {time}', { time: date(device.expiresAtMs) })}</span></div>
          <button className="button button--danger" type="button" disabled={busy || !props.api.revokeRemoteDevice} onClick={() => void act(() => props.api.revokeRemoteDevice!(device.id))}>{t('撤销配对')}</button>
        </div>)}
      </>}
    {error && <p role="alert">{t('远控管理失败：{detail}', { detail: error })}</p>}
  </section>;
}
