import { closeSync, openSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const options = parseArguments(process.argv.slice(2));
const stdout = openSync(options.stdout, 'a');
const stderr = openSync(options.stderr, 'a');

const child = spawn(process.execPath, [options.entry], {
    cwd: options.cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
    env: {
      ...process.env,
      WATCHDOG_PORT: options.port,
      WATCHDOG_DRY_RUN: options.dryRun ? '1' : '',
    },
});
child.unref();
writeFileSync(options.pidFile, `${child.pid}\n`, { encoding: 'utf8', flag: 'w' });
closeSync(stdout);
closeSync(stderr);

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--dry-run') {
      values.set(name, true);
      continue;
    }
    if (!name?.startsWith('--') || index + 1 >= args.length) {
      throw new TypeError(`invalid launcher argument: ${String(name)}`);
    }
    values.set(name, args[index + 1]);
    index += 1;
  }
  const required = ['--entry', '--cwd', '--stdout', '--stderr', '--port', '--pid-file'];
  for (const name of required) {
    if (typeof values.get(name) !== 'string' || values.get(name).length === 0) {
      throw new TypeError(`${name} is required`);
    }
  }
  return {
    entry: values.get('--entry'),
    cwd: values.get('--cwd'),
    stdout: values.get('--stdout'),
    stderr: values.get('--stderr'),
    port: values.get('--port'),
    pidFile: values.get('--pid-file'),
    dryRun: values.get('--dry-run') === true,
  };
}
