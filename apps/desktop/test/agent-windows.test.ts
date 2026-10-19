import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentWindowManager, type ElectronShell } from '../src/main.js';

const id = 'agent-11111111-2222-4333-8444-555555555555';
function fixture() {
  const children: Array<{ urls: string[]; options: Record<string, unknown>; shown: number; close: () => void }> = [];
  const shell = { shell: { openExternal: async () => undefined }, BrowserWindow: class {
    readonly webContents = { setWindowOpenHandler: () => undefined, on: () => undefined };
    readonly record = { urls: [] as string[], options: {} as Record<string, unknown>, shown: 0, close: () => this.closed() };
    private closed: () => void = () => undefined;
    private destroyed = false;
    constructor(options: Record<string, unknown>) { this.record.options = options; children.push(this.record); }
    async loadURL(url: string) { this.record.urls.push(url); }
    on(event: string, callback: () => void) { if (event === 'closed') this.closed = callback; }
    once() {}
    show() { this.record.shown += 1; }
    hide() {}
    focus() {}
    isMinimized() { return false; }
    restore() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.closed(); }
  } } as unknown as ElectronShell;
  return { shell, children };
}

test('independent windows share one owned session, reuse an existing viewer and can be reopened after closing', async () => {
  const { shell, children } = fixture();
  let reads = 0;
  const manager = createAgentWindowManager(shell, { serviceOrigin: 'http://127.0.0.1:48920', preloadPath: '/app/preload.cjs', agents: async () => { reads++; return [{ id, title: 'Claude' }]; } });
  await Promise.all([manager.open(id), manager.open(id)]);
  assert.equal(children.length, 1); assert.equal(reads, 1);
  assert.equal(new URL(children[0]!.urls[0]!).searchParams.get('agent'), id);
  assert.equal((children[0]!.options.webPreferences as { preload: string }).preload, '/app/preload.cjs');
  await manager.open(id); assert.equal(children.length, 1); assert.equal(children[0]!.shown, 1);
  children[0]!.close(); assert.equal(manager.all().length, 0);
  await manager.open(id); assert.equal(children.length, 2);
});

test('an unknown agent id creates no child window', async () => {
  const { shell, children } = fixture();
  const manager = createAgentWindowManager(shell, { serviceOrigin: 'http://127.0.0.1:48920', agents: async () => [] });
  await assert.rejects(manager.open(id), /已关闭/u);
  await assert.rejects(manager.open('../unknown'), /编号无效/u);
  assert.equal(children.length, 0);
});
