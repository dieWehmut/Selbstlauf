import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { APP_VERSION } from '../src/App';

/**
 * The version the app displays has to be the version that was built.
 *
 * 关于 shows `版本 {APP_VERSION}` in a chip, and the constant is written by hand while the manifest is bumped by
 * whatever cuts a release. They agree today; nothing made them keep agreeing, and a wrong version is the kind of
 * defect that is noticed by a user reporting a bug against a build that does not exist.
 *
 * The manifest is the source: the test reads `apps/web/package.json` (vitest runs with this workspace as its working
 * directory) rather than restating the number, so bumping the package is enough to make the app agree — and bumping
 * only the package fails here.
 */
describe('the displayed version', () => {
  it('is the version of the package it was built from', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown };
    expect(typeof manifest.version, 'the manifest has no version to compare against').toBe('string');
    expect(APP_VERSION, 'the 关于 chip would show a version the build does not have').toBe(manifest.version);
  });
});