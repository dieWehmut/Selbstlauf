import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Use the user's npm installation even when the service runs inside Electron. */
export async function runNpmCommand(args: readonly string[], timeout: number): Promise<string> {
  let executable = 'npm';
  let arguments_ = [...args];
  if (process.platform === 'win32') {
    // Windows npm shims require a shell. Resolve their JavaScript entry point
    // and system Node instead, preserving PATH priority and argument boundaries.
    const path = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    const directories = path.split(delimiter)
      .map((directory) => directory.trim().replace(/^"(.*)"$/u, '$1'))
      .filter(Boolean);
    const npmCli = directories
      .map((directory) => resolve(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
      .find(isFile);
    if (npmCli === undefined) throw new Error('npm was not found on PATH. Install Node.js with npm and restart Selbstlauf.');

    const npmDirectory = resolve(dirname(npmCli), '..', '..', '..');
    const node = [npmDirectory, ...directories]
      .map((directory) => resolve(directory, 'node.exe'))
      .find(isFile);
    if (node === undefined) throw new Error('Node.js was not found on PATH. Install Node.js and restart Selbstlauf.');
    executable = node;
    arguments_ = [npmCli, ...args];
  }

  const { stdout } = await execFileAsync(executable, arguments_, {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout,
  });
  return stdout;
}
