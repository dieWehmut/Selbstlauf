import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAUNCHER_MATCH_TOLERANCE_SEC,
  parseWslLaunchers,
  terminalForInterop,
} from '../src/process/wsl-launcher.js';

/**
 * Attributing a WSL session to the Windows terminal it was launched from.
 *
 * The user's request is that a Codex session inside WSL, started from Tabby, be grouped with Tabby rather than
 * under its own operating system. The pairing itself was measured on a real machine — socket `66223_interop`
 * created at 15:44:09 against `wsl.exe` 30044 started at 15:44:08, under `Tabby.exe` — and these tests pin the
 * logic that reproduces it.
 */

test('parses a launcher line into pid, start time and chain', () => {
  const launchers = parseWslLaunchers('30044|1789890248|wsl.exe,cmd.exe,Tabby.exe\n');
  assert.equal(launchers.length, 1);
  assert.equal(launchers[0]?.pid, 30044);
  assert.equal(launchers[0]?.startedAtSec, 1789890248);
  assert.equal(launchers[0]?.terminal, 'Tabby.exe');
});

test('resolves a nested chain to the outermost terminal', () => {
  // Measured: launching WSL from Tabby produced `wsl.exe < wsl.exe < cmd.exe < Tabby.exe`. The terminal is
  // what a person recognises, so the intermediate wsl.exe must not win.
  const launchers = parseWslLaunchers('12620|1789890248|wsl.exe,wsl.exe,cmd.exe,Tabby.exe\n');
  assert.equal(launchers[0]?.terminal, 'Tabby.exe');
});

test('a wsl.exe under no recognised terminal has none', () => {
  // A service-run wsl.exe has no terminal in its chain, and grouping under one would be wrong.
  const launchers = parseWslLaunchers('4740|1789890000|wsl.exe,services.exe,wininit.exe\n');
  assert.equal(launchers[0]?.terminal, null);
});

test('refuses malformed launcher lines rather than inventing one', () => {
  for (const stdout of ['', 'nonsense', 'abc|def|ghi', '0|1|wsl.exe', '5|0|wsl.exe', '5|1|']) {
    assert.deepEqual(parseWslLaunchers(stdout), [], `stdout ${JSON.stringify(stdout)} should yield nothing`);
  }
});

test('pairs a session with the terminal started at its socket time', () => {
  // The real measurement: one second apart.
  const launchers = parseWslLaunchers(
    '30044|1789890248|wsl.exe,cmd.exe,Tabby.exe\n20180|1789871220|wsl.exe,Code.exe\n',
  );
  const matched = terminalForInterop(1789890249, launchers);
  assert.equal(matched?.terminal, 'Tabby.exe');
  assert.equal(matched?.pid, 30044);
});

test('does not attribute a session to a terminal started long before it', () => {
  // A session whose socket is hours from every launcher has no discoverable terminal, and a wrong grouping is
  // worse than falling back to the distribution.
  const launchers = parseWslLaunchers('30044|1789890248|wsl.exe,cmd.exe,Tabby.exe\n');
  assert.equal(terminalForInterop(1789890248 + 3600, launchers), null);
  assert.equal(terminalForInterop(1789890248 - 3600, launchers), null);
});

test('several wsl.exe from one invocation are not treated as ambiguous', () => {
  /**
   * This is the defect the first version shipped. Launching WSL from Tabby starts `30044` and its child `12620`
   * in the same second, so **both** match the socket with an identical delta. Treating any equal delta as
   * ambiguous returned nothing, which made the pairing fail even though the evidence was unambiguous — the
   * question is which terminal, and two wsl.exe processes in one chain share the same answer.
   */
  const launchers = parseWslLaunchers(
    '30044|1789890248|wsl.exe,cmd.exe,Tabby.exe\n12620|1789890248|wsl.exe,wsl.exe,cmd.exe,Tabby.exe\n',
  );
  const matched = terminalForInterop(1789890249, launchers);
  assert.equal(matched?.terminal, 'Tabby.exe');
});

test('a genuine tie between two different terminals is left unattributed', () => {
  // Two launches in the same second from different terminals cannot be told apart, so no guess is made.
  const launchers = parseWslLaunchers(
    '30044|1789890248|wsl.exe,cmd.exe,Tabby.exe\n20180|1789890248|wsl.exe,Code.exe\n',
  );
  assert.equal(terminalForInterop(1789890248, launchers), null);
});

test('the closest match wins when the deltas differ', () => {
  const launchers = parseWslLaunchers(
    '30044|1789890248|wsl.exe,cmd.exe,Tabby.exe\n20180|1789890240|wsl.exe,Code.exe\n',
  );
  // One second from Tabby, nine from VS Code.
  assert.equal(terminalForInterop(1789890249, launchers)?.terminal, 'Tabby.exe');
});

test('no timestamp means no attribution', () => {
  const launchers = parseWslLaunchers('30044|1789890248|wsl.exe,cmd.exe,Tabby.exe\n');
  for (const value of [undefined, 0, -1, Number.NaN]) {
    assert.equal(terminalForInterop(value, launchers), null);
  }
});

test('the tolerance is what the design documents', () => {
  // WSL creates the socket as the invocation starts, so the two times are within a second or two; ten leaves
  // room for a slow start without letting an unrelated invocation match.
  assert.equal(LAUNCHER_MATCH_TOLERANCE_SEC, 10);
});