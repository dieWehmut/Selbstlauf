import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentApi } from '../src/api/agents';

afterEach(() => vi.unstubAllGlobals());

describe('agent API client', () => {
  it('passes launch arguments and raw terminal input through the session endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createAgentApi();
    await api.launch({ tool: 'opencode', cwd: '/work', args: ['--model', 'one two'] });
    expect(fetchMock).toHaveBeenCalledWith('/api/agents', expect.objectContaining({ method: 'POST', body: JSON.stringify({ tool: 'opencode', cwd: '/work', args: ['--model', 'one two'] }) }));
    await api.input('agent a', '\x1b[A中文\r');
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/agent%20a/input', expect.objectContaining({ method: 'POST', body: JSON.stringify({ data: '\x1b[A中文\r' }) }));
    await api.resize('agent a', 80, 24);
    await api.interrupt('agent a');
    await api.terminate('agent a');
    await api.remove('agent a');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/agents/agent%20a', expect.objectContaining({ method: 'DELETE' }));
  });

  it('surfaces the service reason for a failed launch or input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '找不到命令 opencode' }), { status: 400 })));
    await expect(createAgentApi().launch({ tool: 'opencode', cwd: '/work' })).rejects.toThrow('找不到命令 opencode');
  });
});
