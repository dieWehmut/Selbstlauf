import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { copyRuntimeDependency } from './runtime-dependency-copy.mjs';

const copyModuleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'runtime-dependency-copy.mjs')).href;

test('concurrent CLI builds copy the runtime dependency successfully', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-runtime-copy-concurrent-'));
  const source = join(directory, 'source');
  const target = join(directory, 'target');
  await writeFixture(source, 'new-runtime');
  await writeFixture(target, 'old-runtime');

  try {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => runCopyWorker(source, target)));
    assert.deepEqual(results.filter((result) => result.status === 'rejected'), [], 'a concurrent publisher failed');
    assert.equal(await readFile(join(target, 'package.json'), 'utf8'), '{"version":"new-runtime"}\n');
    assert.equal(await readFile(join(target, 'lib', 'nested', 'socket.js'), 'utf8'), 'new-runtime');
    assert.deepEqual((await readdir(directory)).sort(), ['source', 'target']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed runtime copy preserves the existing target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-runtime-copy-failure-'));
  const source = join(directory, 'missing-source');
  const target = join(directory, 'target');
  await writeFixture(target, 'working-runtime');

  try {
    await assert.rejects(copyRuntimeDependency(source, target));
    assert.equal(await readFile(join(target, 'package.json'), 'utf8'), '{"version":"working-runtime"}\n');
    assert.equal(await readFile(join(target, 'lib', 'nested', 'socket.js'), 'utf8'), 'working-runtime');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeFixture(root, version) {
  await mkdir(join(root, 'lib', 'nested'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), `{"version":"${version}"}\n`),
    writeFile(join(root, 'index.js'), version),
    writeFile(join(root, 'wrapper.mjs'), version),
    writeFile(join(root, 'LICENSE'), version),
    writeFile(join(root, 'lib', 'nested', 'socket.js'), version),
  ]);
}

function runCopyWorker(source, target) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(copyModuleUrl)}).then(({ copyRuntimeDependency }) => copyRuntimeDependency(process.argv[1], process.argv[2]))`,
      source,
      target,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`runtime copy worker exited ${String(code)}: ${stderr}`));
    });
  });
}
