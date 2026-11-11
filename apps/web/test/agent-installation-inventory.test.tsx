import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentApi, AgentCatalog } from '../src/api/agents';
import { AgentInstallationInventory } from '../src/agents/AgentInstallationInventory';

const catalog: AgentCatalog = { platform: 'win32', defaultCwd: 'C:\\Work', tools: [
  { id: 'codex', label: 'Codex', kind: 'cli', command: 'C:\\bin\\codex.cmd', available: true,
    installation: { status: 'installed', path: 'C:\\bin\\codex.cmd', source: 'path' } },
  { id: 'cursor', label: 'Cursor', kind: 'desktop', command: null, available: false,
    installation: { status: 'installed', path: 'C:\\Apps\\Cursor.exe', source: 'standard-location' } },
  { id: 'roo', label: 'Roo Code', kind: 'extension', command: null, available: false,
    installation: { status: 'installed', extensions: [{ id: 'RooVeterinaryInc.roo-cline', path: 'C:\\User\\.vscode\\extensions\\roo' }] } },
  { id: 'workbuddy-intl', label: 'WorkBuddy 国际版', kind: 'desktop', command: null, available: false,
    installation: { status: 'unknown', path: 'C:\\Apps\\WorkBuddyAI.exe', reason: '无法确认应用区域版本' } },
  { id: 'grok', label: 'Grok Build', kind: 'cli', command: null, available: false, installation: { status: 'not-found' } },
  { id: 'shell', label: '终端', kind: 'shell', command: 'powershell.exe', available: true },
  { id: 'custom', label: '自定义智能体', kind: 'custom', command: null, available: true },
] };

function api(readCatalog = vi.fn(async () => catalog)) {
  return { catalog: readCatalog } as unknown as AgentApi;
}

describe('agent installation inventory', () => {
  it('shows native installation results and actual paths for CLI, desktop, and editor extension apps', async () => {
    render(<AgentInstallationInventory api={api()} />);
    const desktop = await screen.findByTestId('agent-inventory-cursor');
    await waitFor(() => expect(desktop).toHaveTextContent('已安装'));
    expect(desktop).toHaveTextContent('C:\\Apps\\Cursor.exe');
    expect(screen.getByTestId('agent-inventory-codex')).toHaveTextContent('C:\\bin\\codex.cmd');
    expect(screen.getByTestId('agent-inventory-roo')).toHaveTextContent('RooVeterinaryInc.roo-cline');
    expect(screen.getByTestId('agent-inventory-roo')).toHaveTextContent('C:\\User\\.vscode\\extensions\\roo');
    expect(screen.getByTestId('agent-inventory-workbuddy-intl')).toHaveTextContent('未知');
    expect(screen.getByTestId('agent-inventory-workbuddy-intl')).toHaveTextContent('无法确认应用区域版本');
    expect(screen.getByTestId('agent-installation-grok')).toHaveTextContent('未找到');
    expect(screen.queryByTestId('agent-inventory-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-inventory-custom')).not.toBeInTheDocument();
    expect(within(desktop).queryByText(/运行中/u)).not.toBeInTheDocument();
  });

  it('keeps absent installation evidence unknown even when a legacy service marks its CLI available', async () => {
    render(<AgentInstallationInventory api={api(vi.fn(async () => ({ ...catalog, tools: [
      { id: 'claude', label: 'Claude Code', kind: 'cli', command: '/bin/claude', available: true },
    ] })))} />);
    await waitFor(() => expect(screen.getByTestId('agent-installation-claude')).toHaveTextContent('未知'));
    expect(screen.getByTestId('agent-installation-claude')).not.toHaveTextContent('已安装');
  });

  it('replaces stale installed results with unknown when refreshing fails', async () => {
    const readCatalog = vi.fn().mockResolvedValueOnce(catalog).mockRejectedValueOnce(new Error('读取注册表超时'));
    render(<AgentInstallationInventory api={api(readCatalog)} />);
    await waitFor(() => expect(screen.getByTestId('agent-installation-cursor')).toHaveTextContent('已安装'));
    await userEvent.setup().click(screen.getByRole('button', { name: '重新检测智能体应用' }));
    expect(await screen.findByRole('status')).toHaveTextContent('安装检测失败，状态未知：读取注册表超时');
    expect(screen.getByTestId('agent-installation-cursor')).toHaveTextContent('未知');
    expect(screen.queryByText('C:\\Apps\\Cursor.exe')).not.toBeInTheDocument();
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });

  it('leaves every hosted demo application unknown without probing the visitor machine', () => {
    const remote = api();
    render(<AgentInstallationInventory api={remote} demo />);
    expect(screen.getByText('在线演示无法检测本机安装状态，请使用本地服务或桌面版。')).toBeVisible();
    expect(screen.getAllByTestId(/^agent-installation-/u)).toHaveLength(22);
    for (const result of screen.getAllByTestId(/^agent-installation-/u)) expect(result).toHaveTextContent('未知');
    expect(screen.queryByText('启动命令未找到')).not.toBeInTheDocument();
    expect(remote.catalog).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '重新检测智能体应用' })).not.toBeInTheDocument();
  });

  it('ignores a pending catalog result after switching to the hosted demo', async () => {
    let resolve!: (value: AgentCatalog) => void;
    const remote = api(vi.fn(() => new Promise<AgentCatalog>((done) => { resolve = done; })));
    const { rerender } = render(<AgentInstallationInventory api={remote} />);
    rerender(<AgentInstallationInventory api={remote} demo />);
    await act(async () => resolve(catalog));
    expect(screen.getByTestId('agent-installation-cursor')).toHaveTextContent('未知');
    expect(screen.queryByText('C:\\Apps\\Cursor.exe')).not.toBeInTheDocument();
  });
});
