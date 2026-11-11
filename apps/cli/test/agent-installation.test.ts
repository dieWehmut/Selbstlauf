import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';
import { agentCatalog } from '../src/agents/catalog.js';
import { detectAgentInstallations, type InstallationFileSystem, type WindowsInstallationSnapshot } from '../src/agents/installation.js';

const emptyWindows = (): WindowsInstallationSnapshot => ({ registry: [], appx: [], processes: [], errors: [] });
const absent = () => Object.assign(new Error('absent'), { code: 'ENOENT' });

function fixture() {
  const executables = new Set<string>();
  const directories = new Map<string, string[]>();
  const manifests = new Map<string, unknown>();
  const denied = new Set<string>();
  const files: InstallationFileSystem = {
    async isExecutableFile(path) {
      if (denied.has(path)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (executables.has(path)) return true;
      if (directories.has(path)) return false;
      throw absent();
    },
    async directories(path) {
      if (denied.has(path)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      const entries = directories.get(path); if (entries) return entries; throw absent();
    },
    async json(path) { if (manifests.has(path)) return manifests.get(path); throw absent(); },
  };
  return { files, executables, directories, manifests, denied };
}

function extension(publisher: string, name: string, targetPlatform?: string) {
  return { publisher, name, version: '1.2.3', engines: { vscode: '^1.90.0' }, main: './dist/extension.js',
    ...(targetPlatform ? { __metadata: { targetPlatform } } : {}) };
}

test('desktop folders and similarly named executable directories do not prove installation', async () => {
  const f = fixture();
  f.directories.set('C:\\Users\\fixture\\AppData\\Local\\Programs\\cursor\\Cursor.exe', []);
  f.directories.set('C:\\Users\\fixture\\AppData\\Local\\Programs\\ZCode', []);
  const inventory = await detectAgentInstallations({ platform: 'win32', home: 'C:\\Users\\fixture', env: {}, files: f.files, windows: async () => emptyWindows() });
  assert.equal(inventory.get('cursor')?.status, 'not-found');
  assert.equal(inventory.get('zcode')?.status, 'not-found');
  assert.equal(inventory.has('shell'), false);
  assert.equal(inventory.has('custom'), false);
  assert.equal(inventory.size, 22);
});

test('Windows registry locations verify actual executables and distinguish both WorkBuddy editions', async () => {
  const f = fixture();
  const domestic = 'D:\\apps\\WorkBuddy\\WorkBuddy.exe';
  const international = 'D:\\apps\\WorkBuddyAI\\WorkBuddyAI.exe';
  const zcode = 'D:\\custom\\ZCode\\ZCode.exe';
  f.executables.add(domestic); f.executables.add(international); f.executables.add(zcode);
  const snapshot = emptyWindows();
  snapshot.registry = [
    { displayName: 'WorkBuddy 5.9.3', installLocation: null, displayIcon: `${domestic},0` },
    { displayName: 'WorkBuddy AI 5.9.4', installLocation: null, displayIcon: `"${international}",0` },
    { displayName: 'ZCode 3.17.2', installLocation: null, displayIcon: 'D:\\custom\\ZCode\\uninstallerIcon.ico' },
    { displayName: 'Cursor helper', installLocation: 'D:\\fake', displayIcon: null },
  ];
  const inventory = await detectAgentInstallations({ platform: 'win32', home: 'C:\\Users\\fixture', env: {}, files: f.files, windows: async () => snapshot });
  assert.deepEqual(inventory.get('workbuddy'), { status: 'installed', path: domestic, source: 'windows-registry' });
  assert.deepEqual(inventory.get('workbuddy-intl'), { status: 'installed', path: international, source: 'windows-registry' });
  assert.equal(inventory.get('zcode')?.path, zcode);
  assert.equal(inventory.get('cursor')?.status, 'not-found');
});

test('registry display names and argv-free process paths cannot interchange WorkBuddy editions', async () => {
  const f = fixture();
  const international = 'D:\\unknown\\WorkBuddyAI.exe';
  f.executables.add(international);
  const snapshot = emptyWindows();
  snapshot.registry = [{ displayName: 'WorkBuddy helper', installLocation: 'D:\\unknown', displayIcon: international }];
  snapshot.processes = [{ executablePath: international }, { executablePath: 'WorkBuddy.exe' }];
  const inventory = await detectAgentInstallations({ platform: 'win32', home: 'C:\\Users\\fixture', env: {}, files: f.files, windows: async () => snapshot });
  assert.equal(inventory.get('workbuddy')?.status, 'not-found');
  assert.deepEqual(inventory.get('workbuddy-intl'), { status: 'installed', path: international, source: 'running-executable' });
});

test('Appx evidence identifies Codex desktop without inventing a terminal command', async () => {
  const f = fixture();
  const path = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\Codex.exe';
  f.executables.add(path);
  const snapshot = emptyWindows();
  snapshot.appx = [{ name: 'OpenAI.Codex', installLocation: win32.dirname(win32.dirname(path)) }];
  const inventory = await detectAgentInstallations({ platform: 'win32', home: 'C:\\Users\\fixture', env: {}, files: f.files, windows: async () => snapshot });
  assert.deepEqual(inventory.get('codex'), { status: 'installed', path, source: 'windows-appx' });
});

test('extensions require real publisher/name metadata and a present entry, independently of folder names', async () => {
  const f = fixture();
  const root = '/home/fixture/.vscode/extensions';
  f.directories.set(root, ['renamed-official', 'rooveterinaryinc.roo-cline-99', 'anthropic.claude-code-99', 'kilocode.kilo-code-99']);
  f.manifests.set(`${root}/renamed-official/package.json`, extension('saoudrizwan', 'claude-dev'));
  f.executables.add(`${root}/renamed-official/dist/extension.js`);
  f.manifests.set(`${root}/rooveterinaryinc.roo-cline-99/package.json`, extension('unrelated', 'roo-cline'));
  f.executables.add(`${root}/rooveterinaryinc.roo-cline-99/dist/extension.js`);
  f.manifests.set(`${root}/anthropic.claude-code-99/package.json`, extension('anthropic', 'claude-code', 'win32-x64'));
  f.executables.add(`${root}/anthropic.claude-code-99/dist/extension.js`);
  f.manifests.set(`${root}/kilocode.kilo-code-99/package.json`, extension('kilocode', 'Kilo-Code'));
  const inventory = await detectAgentInstallations({ platform: 'linux', home: '/home/fixture', env: {}, files: f.files });
  assert.deepEqual(inventory.get('cline'), { status: 'installed', path: `${root}/renamed-official`, source: 'vscode-extension',
    extensions: [{ id: 'saoudrizwan.claude-dev', path: `${root}/renamed-official` }] });
  assert.equal(inventory.get('roo')?.status, 'not-found');
  assert.equal(inventory.get('claude')?.status, 'not-found', 'a Windows native extension is not a Linux installation');
  assert.equal(inventory.get('kilo')?.status, 'not-found', 'a manifest without its entry is not an installed extension');
});

test('unreadable installation sources are unknown while independent positive evidence remains installed', async () => {
  const f = fixture();
  f.denied.add('C:\\Users\\fixture\\.vscode\\extensions');
  f.denied.add('C:\\Users\\fixture\\AppData\\Local\\Programs\\cursor\\Cursor.exe');
  f.executables.add('C:\\Users\\fixture\\AppData\\Local\\Programs\\ZCode\\ZCode.exe');
  const snapshot = emptyWindows(); snapshot.errors.push('registry');
  const inventory = await detectAgentInstallations({ platform: 'win32', home: 'C:\\Users\\fixture', env: {}, files: f.files, windows: async () => snapshot });
  assert.equal(inventory.get('cursor')?.status, 'unknown');
  assert.equal(inventory.get('workbuddy')?.status, 'unknown');
  assert.equal(inventory.get('roo')?.status, 'unknown');
  assert.equal(inventory.get('zcode')?.status, 'installed');
});

test('installation detection times out as unknown without starting an agent', async () => {
  const f = fixture();
  const started = Date.now();
  const inventory = await detectAgentInstallations({ platform: 'win32', home: 'C:\\Users\\fixture', env: {}, files: f.files,
    windows: () => new Promise(() => undefined), timeoutMs: 25 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(inventory.get('cursor')?.status, 'unknown');
  assert.match(inventory.get('cursor')?.reason ?? '', /超时/u);
});

test('a foreign platform catalog cannot reuse local installation evidence', async () => {
  const platform = process.platform === 'win32' ? 'linux' : 'win32';
  const inventory = await detectAgentInstallations({ platform, env: { PATH: '', HOME: '/tmp', USERPROFILE: 'C:\\Users\\fixture' } });
  assert.ok([...inventory.values()].every((entry) => entry.status === 'unknown'));
});

test('native PATH and extension checks read files without executing agent code', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'installation evidence '));
  t.after(() => rm(home, { recursive: true, force: true }));
  const executable = join(home, 'cline');
  const marker = join(home, 'never-created');
  await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\n`); await chmod(executable, 0o755);
  const extensionPath = join(home, '.vscode/extensions/random-extension');
  await mkdir(join(extensionPath, 'dist'), { recursive: true });
  await writeFile(join(extensionPath, 'package.json'), JSON.stringify(extension('saoudrizwan', 'claude-dev')));
  await writeFile(join(extensionPath, 'dist/extension.js'), `throw new Error('never loaded');`);
  const catalog = await agentCatalog('linux', { HOME: home, PATH: home }, home);
  const cline = catalog.tools.find((entry) => entry.id === 'cline')!;
  assert.equal(cline.available, true);
  assert.equal(cline.installation?.status, 'installed');
  assert.equal(cline.installation?.path, executable);
  assert.equal(cline.installation?.source, 'path');
  assert.equal(cline.installation?.extensions?.[0]?.path, extensionPath);
  await assert.rejects(import('node:fs/promises').then(({ stat }) => stat(marker)), { code: 'ENOENT' });
  const onlyExtension = await agentCatalog('linux', { HOME: home, PATH: '' }, home);
  assert.equal(onlyExtension.tools.find((entry) => entry.id === 'cline')?.available, false);
  assert.equal(onlyExtension.tools.find((entry) => entry.id === 'cline')?.installation?.status, 'installed');
});
