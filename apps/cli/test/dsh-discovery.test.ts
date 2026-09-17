import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseWindowsProcessJson,
  type RawProcessRecord,
} from '../src/process/process-provider.js';
import { detectProcessTool, groupProcesses } from '../src/process/discovery.js';
import { currentUserSid } from './fixtures/windows-processes.js';

test('detectProcessTool recognizes a DeepSeek Harness host and its subprocess runner', () => {
  const base = {
    parentPid: 1,
    creationTimeMs: 1,
    userSid: currentUserSid,
  };
  const dshRecords: readonly RawProcessRecord[] = [
    {
      ...base,
      pid: 700,
      name: 'node.exe',
      commandLine: 'node  "D:\\project\\deepseek-harness\\apps\\cli\\lib\\bin.js" web',
      executablePath: 'D:\\software\\node.js\\node.exe',
    },
    {
      ...base,
      pid: 701,
      name: 'node.exe',
      commandLine: 'node D:\\project\\deepseek-harness\\packages\\subprocess\\subprocess-local\\lib\\runner.js -- powershell.exe -Command x',
      executablePath: 'D:\\software\\node.js\\node.exe',
    },
    {
      ...base,
      pid: 702,
      name: 'node.exe',
      commandLine: '"node" "C:\\Users\\u\\AppData\\Roaming\\npm\\\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" run',
      executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    },
    {
      ...base,
      pid: 703,
      name: 'dsh.exe',
      commandLine: '"C:\\Tools\\dsh.exe" web',
      executablePath: 'C:\\Tools\\dsh.exe',
    },
  ];

  assert.deepEqual(
    dshRecords.map((record) => detectProcessTool(record)),
    ['dsh', 'dsh', 'dsh', 'dsh'],
  );
});

test('detectProcessTool keeps an unrelated shell that only names the harness checkout neutral', () => {
  const record: RawProcessRecord = {
    pid: 710,
    parentPid: 1,
    name: 'powershell.exe',
    commandLine: 'powershell.exe -Command "Get-ChildItem D:\\project\\deepseek-harness\\packages"',
    executablePath: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    creationTimeMs: 1,
    userSid: currentUserSid,
  };

  assert.equal(detectProcessTool(record), null);
});

test('detectProcessTool honors configured DeepSeek Harness executable names exactly', () => {
  const record: RawProcessRecord = {
    pid: 720,
    parentPid: 1,
    name: 'team-harness.exe',
    commandLine: '"C:\\Tools\\team-harness.exe" web',
    executablePath: 'C:\\Tools\\team-harness.exe',
    creationTimeMs: 1,
    userSid: currentUserSid,
  };

  assert.equal(detectProcessTool(record, { dshExecutableNames: ['team-harness.exe'] }), 'dsh');
  assert.equal(
    detectProcessTool(
      {
        ...record,
        name: 'other.exe',
        commandLine: '"C:\\Tools\\other.exe" web',
        executablePath: 'C:\\Tools\\other.exe',
      },
      { dshExecutableNames: ['team-harness.exe'] },
    ),
    null,
  );
});

test('groupProcesses attaches harness subprocesses to the harness host root', () => {
  const records = parseWindowsProcessJson(JSON.stringify([
    {
      pid: 700,
      parentPid: 1,
      name: 'node.exe',
      commandLine: 'node "D:\\project\\deepseek-harness\\apps\\cli\\lib\\bin.js" web',
      executablePath: 'D:\\software\\node.js\\node.exe',
      creationDate: null,
      userSid: currentUserSid,
      workingDirectory: null,
    },
    {
      pid: 701,
      parentPid: 700,
      name: 'node.exe',
      commandLine: 'node D:\\project\\deepseek-harness\\packages\\subprocess\\subprocess-local\\lib\\runner.js -- cmd',
      executablePath: 'D:\\software\\node.js\\node.exe',
      creationDate: null,
      userSid: currentUserSid,
      workingDirectory: null,
    },
  ]));

  const sessions = groupProcesses(records, { currentUserSid });

  assert.deepEqual(
    sessions.map(({ tool, rootPid, childPids }) => ({ tool, rootPid, childPids })),
    [{ tool: 'dsh', rootPid: 700, childPids: [701] }],
  );
});