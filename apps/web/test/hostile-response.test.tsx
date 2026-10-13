import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import App from '../src/App';
import type { EnvironmentView, SessionView, WatchdogApi, WatchdogConfig, WatchdogEvent } from '../src/api/client';

/**
 * What the app does with a response it does not recognise.
 *
 * Three defects in three rounds came from one pair: a closed type union in the web client, and a response that is
 * cast rather than validated (`client.ts`). The tool label said "Claude" for a tool it had never heard of; the
 * capability badge rendered an empty pill for an unknown transport; and `nextPrompt` threw
 * `Cannot read properties of undefined (reading 'normalPrompt')` — which, with no error boundary, unmounted the whole
 * console. Each was found by accident while fixing the previous one, so this sweeps for the family instead: every
 * field of a session, of the config and of an audit event is replaced with something the union does not admit.
 *
 * The assertions are about *tolerance* rather than about any particular wording: the session must still be listed
 * (an unrecognised value must not silently drop a row) and the page must still render. A throw needs no assertion —
 * an unhandled error in a render fails the run on its own, which is exactly how the last defect announced itself.
 */

const CONFIG: WatchdogConfig = {
  enabled: true,
  dryRun: true,
  pollIntervalMs: 2_000,
  defaultIdleTimeoutMs: 120_000,
  defaultCooldownMs: 60_000,
  maxAttemptsPerQuietPeriod: 1,
  processFilters: { sameUserOnly: true, include: [], exclude: [] },
  tools: {
    claude: {
      enabled: true,
      normalPrompt: '请继续',
      stopHook: { enabled: false, leaseTtlMs: 60_000, commandTimeoutMs: 30_000 },
    },
    codex: { enabled: true, normalPrompt: '继续', goalPrompt: '/goal resume', goalStatuses: ['active', 'paused'] },
    dsh: { enabled: true, normalPrompt: '继续', sessionWindowMs: 600_000, allowApiInput: true },
  },
};

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 'codex:1',
    tool: 'codex',
    rootPid: 100,
    childPids: [],
    conversationId: 'conv-1',
    goal: { status: 'paused' },
    transport: 'codex-app-server',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: 1,
    lastActivityAtMs: 2,
    quietForMs: 1_000,
    pendingPrompt: null,
    lastDecision: 'awaiting-quiet-period',
    host: { processId: 1, executableName: 'Tabby.exe', label: 'Tabby', category: 'terminal', windowHandle: 1, windowTitle: 'Tabby' },
    ...overrides,
  } as unknown as SessionView;
}

const ENVIRONMENT: EnvironmentView = { tools: [], upgrades: [], missing: [], checkedAtMs: 1 } as unknown as EnvironmentView;

function api(options: {
  readonly sessions?: readonly SessionView[];
  readonly config?: unknown;
  readonly events?: readonly WatchdogEvent[];
} = {}): { readonly api: WatchdogApi; readonly emit: (event: WatchdogEvent) => void } {
  let listener: ((event: WatchdogEvent) => void) | null = null;
  const stub = {
    health: vi.fn(async () => ({ ok: true, running: true, dryRun: true, lastPollAtMs: Date.now() - 1_000 })),
    config: vi.fn(async () => (options.config ?? CONFIG) as WatchdogConfig),
    updateConfig: vi.fn(async (next: WatchdogConfig) => next),
    sessions: vi.fn(async () => [...(options.sessions ?? [session()])]),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    inject: vi.fn(async () => ({ dryRun: false })),
    focus: vi.fn(async () => ({ focused: true })),
    install: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    startup: vi.fn(async () => ({ installed: false })),
    installStartup: vi.fn(async () => undefined),
    uninstallStartup: vi.fn(async () => undefined),
    claudeHook: vi.fn(async () => ({ installed: false, enabled: false, restartRequired: false, manualReviewRequired: false })),
    installClaudeHook: vi.fn(async () => ({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false })),
    uninstallClaudeHook: vi.fn(async () => ({ installed: false, enabled: false, restartRequired: false, manualReviewRequired: false })),
    disableClaudeHook: vi.fn(async () => ({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false })),
    codexProfiles: vi.fn(async () => ({ path: 'C:/demo/config.toml', exists: true, active: {}, alternatives: {}, current: null })),
    applyCodexProfile: vi.fn(async () => ({ ok: true, changes: [] })),
    environment: vi.fn(async () => ENVIRONMENT),
    refreshEnvironment: vi.fn(async () => ENVIRONMENT),
    upgradeTool: vi.fn(async (id: string) => ({ id, ok: true, output: '' })),
    upgradeAllTools: vi.fn(async () => ({ ok: true, results: [] })),
    subscribe: vi.fn((next: (event: WatchdogEvent) => void) => {
      listener = next;
      return () => undefined;
    }),
  } as unknown as WatchdogApi;
  return { api: stub, emit: (event) => listener?.(event) };
}

/** Fields the union does not admit, one family at a time. */
const HOSTILE_SESSIONS: readonly { readonly label: string; readonly patch: Partial<SessionView> }[] = [
  { label: 'a tool nothing knows', patch: { tool: 'opencode' as SessionView['tool'], pendingPrompt: null } },
  { label: 'a transport nothing knows', patch: { transport: 'exec-pty' as SessionView['transport'], pendingPrompt: null } },
  { label: 'a decision nothing knows', patch: { lastDecision: 'brand-new-state', pendingPrompt: null } },
  { label: 'a goal status nothing knows', patch: { goal: { status: 'thinking' }, pendingPrompt: null } },
  { label: 'a host category nothing knows', patch: { host: { ...session().host!, category: 'holo-deck' as 'terminal' } } },
  { label: 'a transport error nothing knows', patch: { transportError: 'a-reason-no-table-knows' } },
  { label: 'an empty conversation id', patch: { conversationId: '' } },
  { label: 'no host at all and no quiet time', patch: { host: null, quietForMs: null, lastActivityAtMs: null } },
];

/** Config shapes the union does not admit. */
const HOSTILE_CONFIGS: readonly { readonly label: string; readonly config: unknown }[] = [
  { label: 'tools missing a whole tool', config: { ...CONFIG, tools: { codex: CONFIG.tools.codex, dsh: CONFIG.tools.dsh } } },
  { label: 'a tool missing its stop-hook block', config: { ...CONFIG, tools: { ...CONFIG.tools, claude: { enabled: true, normalPrompt: '继续' } } } },
  { label: 'goalStatuses that is not a list', config: { ...CONFIG, tools: { ...CONFIG.tools, codex: { ...CONFIG.tools.codex, goalStatuses: null } } } },
  { label: 'no tools at all', config: { ...CONFIG, tools: {} } },
  { label: 'a poll interval that is a word', config: { ...CONFIG, pollIntervalMs: 'soon' } },
  { label: 'no process filters', config: { ...CONFIG, processFilters: undefined } },
];

describe('responses the app does not recognise', () => {
  for (const { label, patch } of HOSTILE_SESSIONS) {
    it(`still lists a session with ${label}`, async () => {
      render(<App api={api({ sessions: [session(patch)] }).api} />);

      // Listed rather than dropped, and the page around it still renders.
      expect(await screen.findByRole('heading', { name: '进程监控' })).toBeInTheDocument();
      await waitFor(() => expect(document.querySelectorAll('.process-table tbody tr')).toHaveLength(1));
      expect(screen.getAllByText(/PID 100/u).length).toBeGreaterThan(0);
    });
  }

  for (const { label, config } of HOSTILE_CONFIGS) {
    it(`still renders the settings page with ${label}`, async () => {
      render(<App api={api({ config }).api} />);
      await waitFor(() => expect(document.querySelector('.sidebar-row')).not.toBeNull());

      fireEvent.keyDown(document, { key: ',', ctrlKey: true });
      expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();
      // The editor is where the config is read field by field.
      await waitFor(() => expect(document.querySelector('.settings-content')).not.toBeNull());
    });
  }

  it('still renders an audit event it does not recognise', async () => {
    const { api: stub, emit } = api();
    render(<App api={stub} />);
    await waitFor(() => expect(document.querySelector('.sidebar-row')).not.toBeNull());

    emit({
      kind: 'audit',
      event: {
        id: 'hostile-1',
        timestampMs: Date.now(),
        type: 'a-type-nothing-knows',
        sessionId: 'codex:1',
        details: { 'a-key-nothing-knows': 'a value', attempts: 3, nothing: null },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '事件' }));

    const line = await screen.findByText(/a value/u);
    expect(line.textContent, 'an unknown detail is dropped rather than printed under its own key').toContain('a-key-nothing-knows');
  });
});