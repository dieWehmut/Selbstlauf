// Orchestrate native Windows checks from the isolated conda Node runtime in WSL.
import { spawn } from 'node:child_process';

const [file, ...args] = process.argv.slice(2);
if (!file) throw new Error('Usage: node windows-check.mjs WINDOWS_EXECUTABLE [ARG ...]');
process.stdout.write(`orchestrator: ${process.execPath} ${process.version}; conda ${process.env.CONDA_PREFIX}\n`);
const child = spawn(file, args, { stdio: 'inherit' });
child.on('error', (error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
