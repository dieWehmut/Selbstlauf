import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteControlSection } from '../src/settings/RemoteControlSection';
import type { RemoteControlView } from '../src/api/client';

const paired: RemoteControlView = {
  enabled: true,
  host: '0.0.0.0', port: 48921, name: 'Workstation',
  url: 'http://0.0.0.0:48921',
  pairing: { code: '123456', expiresAtMs: Date.now() + 600_000 },
  devices: [{ id: 'phone-1', name: 'Pixel', createdAtMs: 1, expiresAtMs: Date.now() + 90_000 }],
};
afterEach(() => vi.useRealTimers());

describe('local mobile remote control management', () => {
  it('enables the same computer service with explicit LAN settings and disables it', async () => {
    const initial = { enabled: false as const, host: '127.0.0.1', port: 48921, name: 'Selbstlauf' };
    const api = {
      remote: vi.fn(async () => initial),
      enableRemote: vi.fn(async () => paired),
      disableRemote: vi.fn(async () => initial),
    };
    render(<RemoteControlSection api={api} />);
    await screen.findByText(/手机远控尚未启用/);
    expect(screen.getByLabelText('连接范围')).toHaveValue('127.0.0.1');
    fireEvent.change(screen.getByLabelText('连接范围'), { target: { value: '0.0.0.0' } });
    fireEvent.change(screen.getByLabelText('远控端口'), { target: { value: '49000' } });
    fireEvent.change(screen.getByLabelText('电脑名称'), { target: { value: 'Workstation' } });
    fireEvent.click(screen.getByRole('button', { name: '启用手机远控' }));
    expect(await screen.findByText('123456')).toBeInTheDocument();
    expect(api.enableRemote).toHaveBeenCalledWith({ host: '0.0.0.0', port: 49000, name: 'Workstation' });
    fireEvent.click(screen.getByRole('button', { name: '关闭手机远控' }));
    expect(await screen.findByText(/手机远控尚未启用/)).toBeInTheDocument();
    expect(api.disableRemote).toHaveBeenCalledTimes(1);
  });
  it('refreshes a pairing code and revokes a phone using confirmed service responses', async () => {
    const refreshed = { ...paired, pairing: { code: '654321', expiresAtMs: Date.now() + 600_000 } };
    const api = {
      remote: vi.fn(async () => paired),
      refreshRemotePairing: vi.fn(async () => refreshed),
      revokeRemoteDevice: vi.fn(async () => ({ ...refreshed, devices: [] })),
    };
    render(<RemoteControlSection api={api} />);
    expect(await screen.findByText('123456')).toBeInTheDocument();
    expect(screen.getByText('Pixel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成新配对码' }));
    expect(await screen.findByText('654321')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '撤销配对' }));
    expect(await screen.findByText('暂无已配对手机。')).toBeInTheDocument();
    expect(api.revokeRemoteDevice).toHaveBeenCalledWith('phone-1');
  });

  it('keeps a phone visible when revocation fails and reports the failure', async () => {
    render(<RemoteControlSection api={{ remote: async () => paired, revokeRemoteDevice: async () => { throw new Error('disk unavailable'); } }} />);
    await screen.findByText('Pixel');
    fireEvent.click(screen.getByRole('button', { name: '撤销配对' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk unavailable');
    expect(screen.getByText('Pixel')).toBeInTheDocument();
  });

  it('polls the new code after a phone consumes it and stops polling on unmount', async () => {
    vi.useFakeTimers();
    const api = { remote: vi.fn().mockResolvedValueOnce(paired).mockResolvedValue({ ...paired, pairing: { ...paired.pairing, code: '222222' } }) };
    const mounted = render(<RemoteControlSection api={api} />);
    await act(async () => {});
    expect(screen.getByText('123456')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByText('222222')).toBeInTheDocument();
    mounted.unmount();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(api.remote).toHaveBeenCalledTimes(2);
  });

  it('does not let an old poll replace a newly generated code', async () => {
    vi.useFakeTimers();
    let resolvePoll!: (view: RemoteControlView) => void;
    const delayed = new Promise<RemoteControlView>((resolve) => { resolvePoll = resolve; });
    const api = {
      remote: vi.fn().mockResolvedValueOnce(paired).mockReturnValueOnce(delayed),
      refreshRemotePairing: vi.fn(async () => ({ ...paired, pairing: { ...paired.pairing, code: '333333' } })),
    };
    render(<RemoteControlSection api={api} />);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    fireEvent.click(screen.getByRole('button', { name: '生成新配对码' }));
    await act(async () => {});
    await act(async () => resolvePoll(paired));
    expect(screen.getByText('333333')).toBeInTheDocument();
  });

  it('shows disabled status and never contacts a service in demo mode', async () => {
    const api = { remote: vi.fn(async () => ({ enabled: false as const, host: '127.0.0.1', port: 48921, name: 'Selbstlauf' })) };
    const mounted = render(<RemoteControlSection api={api} />);
    expect(await screen.findByText(/手机远控尚未启用/)).toBeInTheDocument();
    mounted.unmount();
    api.remote.mockClear();
    render(<RemoteControlSection api={api} demo />);
    expect(screen.getByText('演示模式不提供手机配对。')).toBeInTheDocument();
    expect(api.remote).not.toHaveBeenCalled();
  });
});
