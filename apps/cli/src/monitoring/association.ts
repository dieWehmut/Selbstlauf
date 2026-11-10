import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type { DiscoveredProcessSession } from '../process/discovery.js';
import { cursorProjectDirectoryName, type ObservedToolSession } from './tool-sessions.js';

export interface ObservedAssociation {
  readonly group: DiscoveredProcessSession;
  readonly session: ObservedToolSession | null;
}

function normalizedPath(value: string): string {
  let path = value;
  if (path.startsWith('file:')) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== 'localhost') path = `\\\\${url.hostname}${path.replaceAll('/', '\\')}`;
    } catch { return ''; }
    if (/^\/[A-Za-z]:/u.test(path)) path = path.slice(1);
  }
  const windows = /^[A-Za-z]:|^\\\\/u.test(path);
  path = (windows ? win32.normalize(path) : posix.normalize(path)).replaceAll('\\', '/').replace(/\/+$/u, '');
  return windows ? path.toLowerCase() : path;
}

function projectMatches(group: DiscoveredProcessSession, session: ObservedToolSession, groups: readonly DiscoveredProcessSession[]): boolean {
  const cwd = group.workingDirectory;
  if (!cwd) return false;
  if (session.cwds.some(path => normalizedPath(path) === normalizedPath(cwd))) return true;
  if (session.tool === 'cursor' && session.projectSlug && session.cwds.length === 0 && cursorProjectDirectoryName(cwd, session.projectSlugKind) === session.projectSlug) {
    // Cursor's directory key loses punctuation and Unicode. Two distinct known
    // directories with the same key cannot establish a unique association.
    const roots = groups.filter(other => other.tool === 'cursor' && other.workingDirectory && cursorProjectDirectoryName(other.workingDirectory, session.projectSlugKind) === session.projectSlug);
    return new Set(roots.map(other => normalizedPath(other.workingDirectory!))).size === 1;
  }
  return session.tool === 'gemini' && !!session.projectHash &&
    createHash('sha256').update(cwd).digest('hex') === session.projectHash;
}

function resumeId(commandLine: string | null): string | null {
  // Quoted prompt text stays one argument and cannot supply a resume option.
  const tokens = commandArguments(commandLine);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (['--prompt', '-p', '--system-prompt', '--system-prompt-file'].includes(token)) { index++; continue; }
    if (/^--(?:resume|session-id|session|chat-id)=/u.test(token)) return token.slice(token.indexOf('=') + 1);
    if (['--resume', '--session-id', '--session', '--chat-id', '-r'].includes(token)) return !tokens[index + 1] || tokens[index + 1]!.startsWith('-') ? 'latest' : tokens[index + 1]!;
  }
  return null;
}

function commandArguments(commandLine: string | null): string[] {
  return (commandLine ?? '').match(/(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+)+/gu)?.map(token => token.replace(/^(['"])(.*)\1$/u, '$2')) ?? [];
}

export function cursorUserDataDirectory(commandLine: string | null): string | undefined {
  const tokens = commandArguments(commandLine);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const value = token === '--user-data-dir' ? tokens[index + 1] : token.startsWith('--user-data-dir=') ? token.slice(16) : undefined;
    if (!value) continue;
    const path = value.replace(/^(['"])(.*)\1$/u, '$2');
    if (win32.isAbsolute(path) || posix.isAbsolute(path)) return path;
  }
  return undefined;
}

/** Associate only observed live roots; an on-disk transcript never creates a process. */
export function associateObservedGroups(groups: readonly DiscoveredProcessSession[], records: readonly ObservedToolSession[], nowMs: number,
  firstObservedAt?: ReadonlyMap<number, number>, profileDirectory?: string,
  ownershipGroups: readonly DiscoveredProcessSession[] = groups): ObservedAssociation[] {
  const result = new Map<DiscoveredProcessSession, ObservedAssociation[]>();
  const claimed = new Set<string>();
  const fresh = (group: DiscoveredProcessSession, session: ObservedToolSession): boolean => session.lastActivityAtMs !== null &&
    session.lastActivityAtMs >= (group.creationTimeMs ?? firstObservedAt?.get(group.rootPid) ?? nowMs) - 5_000;
  // A CLI with an explicit conversation ID is stronger evidence than shared
  // editor history. Reserve it before expanding the desktop hosts.
  for (const group of groups.filter(group => group.processKind !== 'desktop')) {
    const explicit = resumeId(group.commandLine);
    let candidates = records.filter(session => session.tool === group.tool && (explicit && explicit !== 'latest'
      ? session.id === explicit : projectMatches(group, session, ownershipGroups)));
    if (!explicit) candidates = candidates.filter(session => fresh(group, session));
    if (!explicit && groups.some(other => other.rootPid !== group.rootPid && other.tool === group.tool && other.processKind !== 'desktop' &&
      normalizedPath(other.workingDirectory ?? '') === normalizedPath(group.workingDirectory ?? ''))) candidates = [];
    candidates = candidates.filter(session => !claimed.has(`${session.tool}:${session.id}`));
    candidates.sort((a, b) => (b.lastActivityAtMs ?? 0) - (a.lastActivityAtMs ?? 0));
    const selected = candidates.length === 1 || explicit === 'latest' ? candidates[0] ?? null : null;
    if (selected) claimed.add(`${selected.tool}:${selected.id}`);
    result.set(group, [{ group, session: selected }]);
  }
  const desktops = groups.filter(group => group.processKind === 'desktop');
  for (const session of records) {
    const key = `${session.tool}:${session.id}`;
    if (claimed.has(key)) continue;
    // Exported and native Cursor recordings are shared across user-data profiles.
    // Select their owner across all live roots before the current profile claims
    // them. Composer metadata remains owned by the profile that supplied it,
    // including when an exported JSONL file supplies its readable output.
    const sharedCursor = session.tool === 'cursor' && session.source !== 'cursor-composer' && !session.cursorProfileDirectory;
    let hosts = (sharedCursor ? ownershipGroups.filter(group => group.processKind === 'desktop') : desktops)
      .filter(group => group.tool === session.tool && fresh(group, session));
    // A detached background daemon must not take a conversation away from the
    // observed editor window or make that window's association ambiguous.
    const windows = hosts.filter(group => group.host?.windowHandle && group.host.processId === group.rootPid);
    if (windows.length) hosts = windows;
    const exact = hosts.filter(group => projectMatches(group, session, ownershipGroups));
    if (exact.length) hosts = exact;
    else if (hosts.length !== 1 || (session.projectSlug && session.cwds.length === 0)) continue;
    hosts.sort((a, b) => (a.creationTimeMs ?? firstObservedAt?.get(a.rootPid) ?? nowMs) -
      (b.creationTimeMs ?? firstObservedAt?.get(b.rootPid) ?? nowMs) || a.rootPid - b.rootPid);
    const owner = hosts[0]; if (!owner || !groups.includes(owner)) continue;
    claimed.add(key);
    const namespace = owner.distribution ? `wsl:${owner.distribution}:` : '';
    const profile = profileDirectory ? `profile:${createHash('sha256').update(normalizedPath(profileDirectory)).digest('hex').slice(0, 16)}:` : '';
    const associated: ObservedAssociation = { group: { ...owner, logicalId: `${namespace}${owner.tool}:${profile}${session.id}`,
      workingDirectory: session.cwds.find(cwd => normalizedPath(cwd) === normalizedPath(owner.workingDirectory ?? '')) ?? session.cwds[0] ?? owner.workingDirectory ?? null }, session };
    const rows = result.get(owner) ?? []; rows.push(associated); result.set(owner, rows);
  }
  return groups.flatMap(group => result.get(group) ?? [{ group, session: null }]);
}
