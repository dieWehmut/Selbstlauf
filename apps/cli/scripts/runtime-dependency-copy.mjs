import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, readlink, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const lockfile = require('proper-lockfile');

/** Copy selected files and directories from a runtime package into its target. */
export async function copyRuntimeDependency(packageRoot, target) {
  const source = resolve(packageRoot);
  const destination = resolve(target);
  const parent = dirname(destination);
  const suffix = `${process.pid}-${randomUUID()}`;
  const staging = `${destination}.stage-${suffix}`;
  const backup = `${destination}.backup-${suffix}`;
  await mkdir(parent, { recursive: true });
  await mkdir(staging);
  try {
    for (const name of ['package.json', 'index.js', 'wrapper.mjs', 'lib', 'LICENSE']) {
      await cp(resolve(source, name), resolve(staging, name), { recursive: true, errorOnExist: true, force: false });
    }

    const release = await lockfile.lock(parent, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 120, factor: 1, minTimeout: 50, maxTimeout: 50 },
    });
    try {
      if (await sameTree(staging, destination)) return;

      let hadDestination = false;
      try {
        await rename(destination, backup);
        hadDestination = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }

      try {
        await rename(staging, destination);
      } catch (error) {
        if (hadDestination) {
          try { await rename(backup, destination); }
          catch (restoreError) {
            throw new AggregateError([error, restoreError], 'runtime dependency publish and rollback both failed');
          }
        }
        throw error;
      }

      if (hadDestination) await rm(backup, { recursive: true, force: true });
    } finally {
      await release();
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function sameTree(left, right) {
  let leftEntries;
  let rightEntries;
  try {
    [leftEntries, rightEntries] = await Promise.all([readdir(left, { withFileTypes: true }), readdir(right, { withFileTypes: true })]);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
  if (leftEntries.length !== rightEntries.length) return false;
  const rightByName = new Map(rightEntries.map((entry) => [entry.name, entry]));
  for (const leftEntry of leftEntries) {
    const rightEntry = rightByName.get(leftEntry.name);
    if (!rightEntry) return false;
    if (leftEntry.isDirectory() && rightEntry.isDirectory()) {
      if (!await sameTree(resolve(left, leftEntry.name), resolve(right, rightEntry.name))) return false;
    } else if (leftEntry.isSymbolicLink() && rightEntry.isSymbolicLink()) {
      const [leftTarget, rightTarget] = await Promise.all([
        readlink(resolve(left, leftEntry.name)), readlink(resolve(right, rightEntry.name)),
      ]);
      if (leftTarget !== rightTarget) return false;
    } else if (leftEntry.isFile() && rightEntry.isFile()) {
      const [leftContents, rightContents] = await Promise.all([
        readFile(resolve(left, leftEntry.name)), readFile(resolve(right, rightEntry.name)),
      ]);
      if (!leftContents.equals(rightContents)) return false;
    } else {
      return false;
    }
  }
  return true;
}
