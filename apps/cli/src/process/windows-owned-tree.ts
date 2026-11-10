import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WindowsOwnedTreeIdentity {
  readonly pid: number;
  readonly createdAfterMs: number;
  readonly createdBeforeMs: number;
  readonly ownerPid?: number;
}
export interface WindowsOwnedProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly createdAtMs: number;
}
export interface WindowsOwnedTreeOptions extends WindowsOwnedTreeIdentity {
  /** Includes PowerShell startup, compilation, native termination and verification. */
  readonly timeoutMs?: number;
  readonly powershellPath?: string;
  readonly runCommand?: (executable: string, args: readonly string[], signal: AbortSignal) => Promise<string>;
}
export interface WindowsOwnedTreeResult { readonly verified: boolean; readonly error?: string }

/** The same identity policy as the native implementation, available for process-record audits. */
export function selectWindowsOwnedTree(identity: WindowsOwnedTreeIdentity, records: readonly WindowsOwnedProcess[]): WindowsOwnedProcess[] {
  const root = records.find(row => row.pid === identity.pid && row.createdAtMs >= identity.createdAfterMs &&
    row.createdAtMs <= identity.createdBeforeMs && (identity.ownerPid === undefined || row.parentPid === identity.ownerPid));
  if (!root) return [];
  const selected = new Map<number, { record: WindowsOwnedProcess; depth: number }>([[root.pid, { record: root, depth: 0 }]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of records) {
      const parent = selected.get(row.parentPid);
      if (!selected.has(row.pid) && parent && row.createdAtMs >= parent.record.createdAtMs) {
        selected.set(row.pid, { record: row, depth: parent.depth + 1 }); changed = true;
      }
    }
  }
  return [...selected.values()].sort((a, b) => b.depth - a.depth || b.record.pid - a.record.pid).map(row => row.record);
}

// Windows PowerShell 5.1 uses .NET Framework, where Process.Kill(bool) is unavailable.
// Toolhelp is read-only; every termination uses an opened, identity-checked process handle.
// https://learn.microsoft.com/windows/win32/toolhelp/taking-a-snapshot-and-viewing-processes
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
const NATIVE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SelbstlaufOwnedTree {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
    public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
  sealed class Owned { public uint pid, parent; public int depth; public ulong born; public IntPtr handle; }
  public sealed class Result { public bool verified; public string error; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime born, out FileTime exited, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static long Now() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000L; }
  static void Deadline(long deadline) { if (Now() >= deadline) throw new TimeoutException("owned-tree cleanup deadline exceeded"); }
  static ulong Ticks(FileTime time) { return ((ulong)time.high << 32) | time.low; }
  static ulong Born(IntPtr handle) {
    FileTime born, exited, kernel, user;
    if (!GetProcessTimes(handle, out born, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return Ticks(born);
  }
  static ulong Exited(IntPtr handle) {
    // GetProcessTimes leaves exit time undefined until the process has exited.
    if (Running(handle)) return 0;
    FileTime born, exited, kernel, user;
    if (!GetProcessTimes(handle, out born, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return Ticks(exited);
  }
  static bool Running(IntPtr handle) {
    uint state = WaitForSingleObject(handle, 0);
    if (state == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
    return state == 0x102;
  }
  static Dictionary<uint,Entry> Snapshot(long deadline) {
    Deadline(deadline);
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Entry entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      Dictionary<uint,Entry> rows = new Dictionary<uint,Entry>();
      if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
      do { Deadline(deadline); rows[entry.pid] = entry; } while (Process32NextW(snapshot, ref entry));
      if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception(Marshal.GetLastWin32Error());
      return rows;
    } finally { CloseHandle(snapshot); }
  }
  static IntPtr Open(uint pid) { return OpenProcess(0x00101001, false, pid); }
  public static Result Kill(uint rootPid, uint ownerPid, long after, long before, long deadline) {
    Dictionary<uint,Owned> owned = new Dictionary<uint,Owned>();
    try {
      ulong snapshotBefore = (ulong)DateTime.UtcNow.ToFileTimeUtc();
      Dictionary<uint,Entry> rows = Snapshot(deadline); Entry rootEntry;
      if (!rows.TryGetValue(rootPid, out rootEntry) || rootEntry.parent != ownerPid) throw new InvalidOperationException("root identity absent or owner mismatch");
      IntPtr rootHandle = Open(rootPid);
      if (rootHandle == IntPtr.Zero) throw new InvalidOperationException("root identity unavailable");
      Owned root = new Owned(); root.pid=rootPid; root.parent=ownerPid; root.handle=rootHandle;
      owned.Add(rootPid, root); root.born=Born(rootHandle);
      long rootMs = (long)(root.born / 10000UL) - 11644473600000L;
      if (rootMs < after || rootMs > before || !Running(rootHandle)) throw new InvalidOperationException("root creation identity mismatch or root exited");
      HashSet<uint> skipped = new HashSet<uint>(); bool changed = true;
      while (changed) {
        changed=false;
        foreach (Entry entry in rows.Values) {
          Deadline(deadline); Owned parent;
          if (owned.ContainsKey(entry.pid) || skipped.Contains(entry.pid) || !owned.TryGetValue(entry.parent, out parent)) continue;
          IntPtr handle=Open(entry.pid);
          if (handle == IntPtr.Zero) {
            if (Marshal.GetLastWin32Error() == 87) { skipped.Add(entry.pid); continue; }
            throw new InvalidOperationException("owned descendant handle unavailable: " + entry.pid);
          }
          bool keep=false;
          try {
            ulong born=Born(handle); ulong exit=Exited(parent.handle);
            // A PID created after the snapshot began cannot be the process represented by its parent entry.
            if (born > snapshotBefore) throw new InvalidOperationException("descendant snapshot identity changed: " + entry.pid);
            if (born < parent.born || (exit != 0 && born > exit)) { skipped.Add(entry.pid); continue; }
            Owned child=new Owned(); child.pid=entry.pid; child.parent=entry.parent; child.born=born; child.handle=handle; child.depth=parent.depth+1;
            owned.Add(entry.pid,child); keep=true; changed=true;
          } finally { if (!keep) CloseHandle(handle); }
        }
      }
      List<Owned> ordered=new List<Owned>(owned.Values);
      ordered.Sort(delegate(Owned a, Owned b) { int depth=b.depth.CompareTo(a.depth); return depth!=0 ? depth : b.pid.CompareTo(a.pid); });
      foreach (Owned process in ordered) {
        Deadline(deadline);
        if (!Running(process.handle)) continue;
        if (!TerminateProcess(process.handle, 1) && Running(process.handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
        long remaining=deadline-Now(); if (remaining<=0) throw new TimeoutException("owned-tree cleanup deadline exceeded");
        if (WaitForSingleObject(process.handle, (uint)Math.Min(remaining, 0xfffffffeL)) != 0) throw new TimeoutException("owned process termination unverified: " + process.pid);
      }
      // Root termination alone proves nothing about descendants. Verify each held handle and a fresh snapshot.
      foreach (Owned process in ordered) if (Running(process.handle)) throw new InvalidOperationException("owned process remains: " + process.pid);
      foreach (Entry entry in Snapshot(deadline).Values) {
        Owned parent; if (owned.ContainsKey(entry.pid) || !owned.TryGetValue(entry.parent,out parent)) continue;
        IntPtr handle=OpenProcess(0x00101000,false,entry.pid);
        if (handle==IntPtr.Zero) {
          if (Marshal.GetLastWin32Error()==87) continue;
          throw new InvalidOperationException("descendant verification unavailable: " + entry.pid);
        }
        try {
          ulong born=Born(handle), exited=Exited(parent.handle);
          if (born>=parent.born && (exited==0 || born<=exited) && Running(handle)) throw new InvalidOperationException("owned descendant appeared during cleanup: " + entry.pid);
        } finally { CloseHandle(handle); }
      }
      return new Result { verified=true };
    } catch (Exception error) { return new Result { verified=false, error=error.Message }; }
    finally { foreach (Owned process in owned.Values) CloseHandle(process.handle); }
  }
}
`;

export async function killWindowsOwnedTree(options: WindowsOwnedTreeOptions): Promise<WindowsOwnedTreeResult> {
  const ownerPid = options.ownerPid ?? process.pid;
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0 || options.pid > 0xffff_ffff || options.pid === ownerPid ||
    !Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid > 0xffff_ffff || !Number.isSafeInteger(options.createdAfterMs) ||
    !Number.isSafeInteger(options.createdBeforeMs) || options.createdAfterMs < 0 || options.createdBeforeMs < options.createdAfterMs) {
    return { verified: false, error: 'invalid owned probe identity' };
  }
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : 5_000;
  const deadline = Date.now() + timeoutMs;
  const script = `$ErrorActionPreference = 'Stop'\ntry {\nAdd-Type -TypeDefinition @'\n${NATIVE_SOURCE}\n'@\n` +
    `[SelbstlaufOwnedTree]::Kill([uint32]${options.pid},[uint32]${ownerPid},[long]${Math.floor(options.createdAfterMs)},[long]${Math.ceil(options.createdBeforeMs)},[long]${deadline}) | ConvertTo-Json -Compress\n` +
    `} catch { @{verified=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress }\n`;
  const executable = options.powershellPath ?? (process.platform === 'win32'
    ? win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const run = options.runCommand ?? (async (path: string, commandArgs: readonly string[], signal: AbortSignal) => {
    const result = await execFileAsync(path, [...commandArgs], { cwd: tmpdir(), windowsHide: true, encoding: 'utf8',
      signal, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 });
    return result.stdout;
  });
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`owned-tree cleanup deadline exceeded after ${timeoutMs}ms`);
        abort.abort(error); reject(error);
      }, timeoutMs);
      Promise.resolve().then(() => run(executable, args, abort.signal)).then(resolve, reject);
    });
    const result = JSON.parse(stdout.trim()) as { verified?: unknown; error?: unknown };
    if (result.verified === true) return { verified: true };
    return { verified: false, error: typeof result.error === 'string' ? result.error : 'owned-tree termination was not verified' };
  } catch (error) {
    return { verified: false, error: abort.signal.aborted ? `owned-tree cleanup deadline exceeded after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); }
}
