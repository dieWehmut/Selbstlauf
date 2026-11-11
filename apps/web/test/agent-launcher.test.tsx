import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentLauncher } from '../src/agents/AgentLauncher';
import type { AgentApi, AgentCatalog, AgentSession } from '../src/api/agents';

const catalog: AgentCatalog = {
  platform: 'linux', defaultCwd: '/work/project', tools: [
    { id: 'claude', label: 'Claude Code', command: '/bin/claude', available: true },
    { id: 'opencode', label: 'OpenCode', command: null, available: false, installCommand: 'npm install -g opencode-ai' },
    { id: 'custom', label: '自定义智能体', command: null, available: true },
  ],
};
const session: AgentSession = {
  id: 'agent-1', tool: 'claude', title: 'Claude Code', pid: 42, status: 'running',
  command: '/bin/claude', args: [], cwd: '/work/project', startedAtMs: 1, endedAtMs: null,
  exitCode: null, signal: null, cols: 100, rows: 30,
};

function setup(overrides: Partial<AgentApi> = {}) {
  const api = { catalog: vi.fn(async () => catalog), launch: vi.fn(async () => session), ...overrides } as unknown as AgentApi;
  const onLaunch = vi.fn();
  const onInstall = vi.fn();
  render(<AgentLauncher api={api} onClose={vi.fn()} onLaunch={onLaunch} onInstall={onInstall} />);
  return { api, onLaunch, onInstall };
}

describe('agent launcher', () => {
  it('starts a chosen agent in its working directory with literal, separate arguments', async () => {
    const { api, onLaunch } = setup();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText('工作目录')).toHaveValue('/work/project'));
    await user.click(screen.getByText('启动命令与参数'));
    await user.type(screen.getByLabelText('额外启动参数（每行一个）'), 'one two{Enter}a&b{Enter}中文');
    await user.type(screen.getByLabelText('窗口名称（可选）'), '项目 A');
    await user.click(screen.getByRole('button', { name: '启动' }));
    expect(api.launch).toHaveBeenCalledWith({ tool: 'claude', cwd: '/work/project', args: ['one two', 'a&b', '中文'], title: '项目 A' });
    expect(onLaunch).toHaveBeenCalledWith(session);
  });

  it('shows a missing tool and permits an explicit executable path', async () => {
    const { api } = setup();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText('智能体')).toBeEnabled());
    await user.selectOptions(screen.getByLabelText('智能体'), 'opencode');
    expect(screen.getByRole('button', { name: '启动' })).toBeDisabled();
    expect(screen.getByText('npm install -g opencode-ai')).toBeVisible();
    await user.type(screen.getByLabelText('启动命令', { exact: true }), '/custom/opencode');
    await user.click(screen.getByRole('button', { name: '启动' }));
    expect(api.launch).toHaveBeenCalledWith({ tool: 'opencode', cwd: '/work/project', command: '/custom/opencode' });
  });

  it('retains the request fields and displays the real service failure', async () => {
    const { onLaunch } = setup({ launch: vi.fn(async () => { throw new Error('工作目录不存在'); }) });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('button', { name: '启动' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启动' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('工作目录不存在');
    expect(screen.getByLabelText('工作目录')).toHaveValue('/work/project');
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('offers official installation and setup guides for an editor extension without starting a PTY', async () => {
    const { api } = setup({ catalog: vi.fn(async () => ({ ...catalog, tools: [...catalog.tools, {
      id: 'roo', label: 'Roo Code', kind: 'extension', launchable: false, command: null, available: false,
      installUrl: 'https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline',
      docsUrl: 'https://github.com/RooCodeInc/Roo-Code', guideUrls: ['https://agentrouter.org/docs/roocode.html'],
    }] } as AgentCatalog)) });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText('智能体')).toBeEnabled());
    await user.selectOptions(screen.getByLabelText('智能体'), 'roo');
    expect(screen.getByRole('link', { name: '官方安装' })).toHaveAttribute('href', 'https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline');
    expect(screen.getByRole('link', { name: 'AgentRouter 接入指南' })).toHaveAttribute('href', 'https://agentrouter.org/docs/roocode.html');
    expect(screen.queryByRole('button', { name: '启动' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('工作目录')).not.toBeInTheDocument();
    expect(api.launch).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('智能体'), 'claude');
    expect(screen.getByLabelText('工作目录')).toHaveValue('/work/project');
    expect(screen.getByRole('button', { name: '启动' })).toBeEnabled();
  });

  it('detects a newly installed CLI without losing the working directory or arguments', async () => {
    const readCatalog = vi.fn().mockResolvedValueOnce(catalog).mockResolvedValueOnce({
      ...catalog, tools: catalog.tools.map((entry) => entry.id === 'opencode' ? { ...entry, available: true, command: '/bin/opencode' } : entry),
    });
    const { api } = setup({ catalog: readCatalog });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText('智能体')).toBeEnabled());
    await user.selectOptions(screen.getByLabelText('智能体'), 'opencode');
    await user.type(screen.getByLabelText('额外启动参数（每行一个）'), '--version');
    await user.click(screen.getByRole('button', { name: '重新检测本机工具' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '启动' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启动' }));
    expect(api.launch).toHaveBeenCalledWith({ tool: 'opencode', cwd: '/work/project', args: ['--version'] });
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });

  it('does not start a process or probe a machine in the hosted demo', () => {
    const api = { catalog: vi.fn(), launch: vi.fn() } as unknown as AgentApi;
    render(<AgentLauncher api={api} demo onClose={vi.fn()} onLaunch={vi.fn()} onInstall={vi.fn()} />);
    expect(screen.getByText(/在线演示无法启动本机进程/u)).toBeVisible();
    expect(api.catalog).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
  });
});
