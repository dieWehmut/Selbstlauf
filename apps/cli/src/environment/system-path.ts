import { statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function pathDirectories(): string[] {
  const path = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  return path.split(delimiter)
    .map((directory) => directory.trim().replace(/^"(.*)"$/u, '$1'))
    .filter(Boolean);
}

export function executableExistsOnPath(executable: string, platform: NodeJS.Platform): boolean {
  const extensions = platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  return pathDirectories().some((directory) => extensions.some((extension) => (
    isFile(resolve(directory, `${executable}${extension}`))
  )));
}
