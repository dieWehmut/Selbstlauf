param(
    [string[]]$IncludeExecutableName = @(),
    [int[]]$IncludeProcessId = @(),
    # Window-title markers, comma separated in ONE argument.
    #
    # This is `[string]` rather than `[string[]]` on purpose. Under `-File`, arguments arrive as literal
    # strings and are not parsed as PowerShell expressions, so an array parameter cannot be bound from the
    # command line at all: repeating `-WindowTitleMarker a -WindowTitleMarker b` fails with
    # "parameter is specified more than once", and the documented array syntax `-WindowTitleMarker a,b`
    # binds the whole thing as the SINGLE string "a,b". Measured both ways. A single string that the script
    # splits is therefore the only form that works, and it is what the caller sends.
    [string]$WindowTitleMarker = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The provider's stdout is captured through a pipe, where Windows PowerShell 5.1
# would otherwise encode non-ASCII window titles and paths in the OEM code page
# and the caller would read mojibake.
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    # A host without a console keeps its own encoding; the caller still parses.
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Selbstlauf.ProcessMetadata {
    public sealed class WindowRecord {
        public long Handle;
        public int Pid;
        public string Title;
        public string ClassName;
        public bool Visible;
    }

    public static class TopLevelWindowReader {
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        private const string FrameHostImage = "applicationframehost.exe";

        private static WindowRecord Describe(IntPtr hWnd) {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            StringBuilder title = new StringBuilder(512);
            GetWindowTextW(hWnd, title, title.Capacity);
            StringBuilder className = new StringBuilder(256);
            GetClassNameW(hWnd, className, className.Capacity);
            return new WindowRecord {
                Handle = hWnd.ToInt64(),
                Pid = (int)pid,
                Title = title.ToString(),
                ClassName = className.ToString(),
                Visible = IsWindowVisible(hWnd),
            };
        }

        /// <summary>
        /// Every titled top-level window. A UWP frame is owned by
        /// ApplicationFrameHost, so the titled child window is reported with the
        /// identifier of the process that actually renders it.
        /// </summary>
        public static WindowRecord[] Read() {
            List<WindowRecord> list = new List<WindowRecord>();
            EnumWindows((hWnd, _) => {
                WindowRecord window = Describe(hWnd);
                if (window.Title.Length == 0) {
                    return true;
                }
                list.Add(window);
                if (window.ClassName.Equals("ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase)) {
                    EnumChildWindows(hWnd, (child, __) => {
                        WindowRecord inner = Describe(child);
                        if (inner.Title.Length > 0) {
                            list.Add(inner);
                        }
                        return true;
                    }, IntPtr.Zero);
                }
                return true;
            }, IntPtr.Zero);
            return list.ToArray();
        }
    }

    public static class CurrentDirectoryReader {
        private const uint ProcessQueryInformation = 0x0400;
        private const uint ProcessVmRead = 0x0010;
        private const int ProcessBasicInformation = 0;
        private const int ProcessWow64Information = 26;

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_BASIC_INFORMATION {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2_0;
            public IntPtr Reserved2_1;
            public IntPtr UniqueProcessId;
            public IntPtr Reserved3;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ReadProcessMemory(
            IntPtr process,
            IntPtr address,
            [Out] byte[] buffer,
            UIntPtr size,
            out UIntPtr bytesRead);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(
            IntPtr process,
            int informationClass,
            out PROCESS_BASIC_INFORMATION information,
            int informationLength,
            out int returnLength);

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(
            IntPtr process,
            int informationClass,
            out IntPtr information,
            int informationLength,
            out int returnLength);

        public static string TryRead(int processId) {
            IntPtr process = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, processId);
            if (process == IntPtr.Zero) {
                return null;
            }

            try {
                IntPtr pebAddress;
                int pointerSize;
                if (!TryResolvePeb(process, out pebAddress, out pointerSize)) {
                    return null;
                }

                int processParametersOffset = pointerSize == 8 ? 0x20 : 0x10;
                IntPtr processParameters = ReadPointer(process, Add(pebAddress, processParametersOffset), pointerSize);
                if (processParameters == IntPtr.Zero) {
                    return null;
                }

                int currentDirectoryOffset = pointerSize == 8 ? 0x38 : 0x24;
                IntPtr unicodeString = Add(processParameters, currentDirectoryOffset);
                byte[] header = ReadBytes(process, unicodeString, pointerSize == 8 ? 16 : 8);
                if (header == null) {
                    return null;
                }

                int length = BitConverter.ToUInt16(header, 0);
                if (length <= 0 || length > 32766 || (length % 2) != 0) {
                    return null;
                }
                int bufferOffset = pointerSize == 8 ? 8 : 4;
                IntPtr buffer = PointerFromBytes(header, bufferOffset, pointerSize);
                if (buffer == IntPtr.Zero) {
                    return null;
                }

                byte[] text = ReadBytes(process, buffer, length);
                return text == null ? null : Encoding.Unicode.GetString(text).TrimEnd('\0');
            } catch {
                return null;
            } finally {
                CloseHandle(process);
            }
        }

        private static bool TryResolvePeb(IntPtr process, out IntPtr pebAddress, out int pointerSize) {
            pebAddress = IntPtr.Zero;
            pointerSize = IntPtr.Size;

            if (IntPtr.Size == 8) {
                IntPtr wow64Peb;
                int wow64Length;
                int wow64Status = NtQueryInformationProcess(
                    process,
                    ProcessWow64Information,
                    out wow64Peb,
                    IntPtr.Size,
                    out wow64Length);
                if (wow64Status == 0 && wow64Peb != IntPtr.Zero) {
                    pebAddress = wow64Peb;
                    pointerSize = 4;
                    return true;
                }
            }

            PROCESS_BASIC_INFORMATION basic;
            int basicLength;
            int status = NtQueryInformationProcess(
                process,
                ProcessBasicInformation,
                out basic,
                Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)),
                out basicLength);
            if (status != 0 || basic.PebBaseAddress == IntPtr.Zero) {
                return false;
            }
            pebAddress = basic.PebBaseAddress;
            return true;
        }

        private static IntPtr ReadPointer(IntPtr process, IntPtr address, int pointerSize) {
            byte[] bytes = ReadBytes(process, address, pointerSize);
            return bytes == null ? IntPtr.Zero : PointerFromBytes(bytes, 0, pointerSize);
        }

        private static IntPtr PointerFromBytes(byte[] bytes, int offset, int pointerSize) {
            return pointerSize == 8
                ? new IntPtr(BitConverter.ToInt64(bytes, offset))
                : new IntPtr(BitConverter.ToInt32(bytes, offset));
        }

        private static byte[] ReadBytes(IntPtr process, IntPtr address, int length) {
            byte[] buffer = new byte[length];
            UIntPtr bytesRead;
            if (!ReadProcessMemory(process, address, buffer, new UIntPtr((uint)length), out bytesRead) ||
                bytesRead.ToUInt64() != (ulong)length) {
                return null;
            }
            return buffer;
        }

        private static IntPtr Add(IntPtr address, int offset) {
            return IntPtr.Size == 8
                ? new IntPtr(address.ToInt64() + offset)
                : new IntPtr(address.ToInt32() + offset);
        }
    }

    public static class ProcessOwnerReader {
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint TokenQuery = 0x0008;
        private const int TokenUser = 1;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(
            IntPtr token,
            int informationClass,
            IntPtr information,
            int informationLength,
            out int returnLength);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr handle);

        /// <summary>
        /// Read the process owner SID from its token. WMI's GetOwnerSid costs
        /// roughly half a second per process, which made one discovery pass take
        /// minutes on a busy desktop; the token read takes microseconds.
        /// </summary>
        public static string TryRead(int processId) {
            IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
            if (process == IntPtr.Zero) {
                return null;
            }

            IntPtr token = IntPtr.Zero;
            IntPtr buffer = IntPtr.Zero;
            try {
                if (!OpenProcessToken(process, TokenQuery, out token)) {
                    return null;
                }

                int size;
                GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out size);
                if (size <= 0) {
                    return null;
                }

                buffer = Marshal.AllocHGlobal(size);
                if (!GetTokenInformation(token, TokenUser, buffer, size, out size)) {
                    return null;
                }

                IntPtr sid = Marshal.ReadIntPtr(buffer);
                if (sid == IntPtr.Zero) {
                    return null;
                }

                IntPtr text;
                if (!ConvertSidToStringSid(sid, out text)) {
                    return null;
                }
                try {
                    return Marshal.PtrToStringUni(text);
                } finally {
                    LocalFree(text);
                }
            } catch {
                return null;
            } finally {
                if (buffer != IntPtr.Zero) {
                    Marshal.FreeHGlobal(buffer);
                }
                if (token != IntPtr.Zero) {
                    CloseHandle(token);
                }
                CloseHandle(process);
            }
        }
    }
}
'@

$includeNames = @(
    foreach ($configuredName in $IncludeExecutableName) {
        $normalizedName = ([string]$configuredName).Trim().Trim('"').Replace('/', '\\')
        if ($normalizedName.Length -gt 0) {
            $lastSeparator = $normalizedName.LastIndexOf('\\')
            $normalizedName.Substring($lastSeparator + 1).ToLowerInvariant()
        }
    }
)

$includeProcessIds = @(
    foreach ($configuredId in $IncludeProcessId) {
        [int]$configuredId
    }
)

# Split the comma-separated marker list the caller sends. See the param block for why this is a string.
$windowTitleMarkers = @(
    $WindowTitleMarker -split ',' |
        ForEach-Object { ([string]$_).Trim() } |
        Where-Object { $_.Length -gt 0 }
)

# The signature that marks a process as a supported CLI. It is used both to keep
# the record (the node image name alone is far too broad) and to describe why an
# otherwise unrelated process is being reported.
$workingDirectoryPattern = '(?i)(?:claude-code|claude\.ps1|@openai[\\/]codex|codex\.js|codex\.exe|@deepseek-ai[\\/]dsh|deepseek-harness[\\/]apps[\\/]cli[\\/]lib[\\/]bin\.js|deepseek-harness[\\/]packages[\\/]subprocess|dsh\.(?:cmd|ps1|exe))'

function ConvertTo-NullableString {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) {
        return $null
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }
    return $text
}

function Resolve-OwnerSid {
    param([object]$Process, [int]$ProcessId)

    try {
        $sid = [Selbstlauf.ProcessMetadata.ProcessOwnerReader]::TryRead($ProcessId)
        if (-not [string]::IsNullOrWhiteSpace($sid)) {
            return $sid
        }
    } catch {
        # Fall through to the WMI owner lookup below.
    }

    try {
        # GetOwnerSid is implemented by current Windows versions and avoids
        # a potentially blocking domain lookup for protected/system accounts.
        $ownerSid = $Process.GetOwnerSid()
        if ($null -ne $ownerSid -and $ownerSid.ReturnValue -eq 0 -and -not [string]::IsNullOrWhiteSpace($ownerSid.Sid)) {
            return [string]$ownerSid.Sid
        }
    } catch {
        # Fall through to GetOwner for older WMI providers.
    }

    try {
        # GetOwner is available in Windows PowerShell 5.1 and returns the
        # domain/user pair needed to translate the owner to a stable SID.
        $owner = $Process.GetOwner()
        if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.User)) {
            return $null
        }

        $account = New-Object System.Security.Principal.NTAccount -ArgumentList @($owner.Domain, $owner.User)
        return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $null
    }
}

function Resolve-WorkingDirectory {
    param([int]$ProcessId)

    try {
        return ConvertTo-NullableString ([Selbstlauf.ProcessMetadata.CurrentDirectoryReader]::TryRead($ProcessId))
    } catch {
        return $null
    }
}

$processIndex = @{}
$allProcesses = @(Get-WmiObject -Class Win32_Process)
foreach ($process in $allProcesses) {
    $indexName = ConvertTo-NullableString $process.Name
    $processIndex[[int]$process.ProcessId] = [pscustomobject]@{
        pid = [int]$process.ProcessId
        parentPid = [int]$process.ParentProcessId
        name = $indexName
        executablePath = ConvertTo-NullableString $process.ExecutablePath
    }
}

# Top-level windows are enumerated once per run. A window is reported for a
# candidate when its owner is an ancestor of that candidate, or when its title
# carries one of the caller's markers (the harness WebUI is served over loopback
# and is therefore owned by the browser, not by any ancestor).
$windowsByOwner = @{}
foreach ($window in [Selbstlauf.ProcessMetadata.TopLevelWindowReader]::Read()) {
    if ([string]::IsNullOrWhiteSpace($window.Title)) {
        continue
    }
    # Hidden windows cannot be shown to a person, so only the visible ones are
    # reported; a marker match is kept regardless because it identifies the
    # harness WebUI tab.
    $ownerPid = [int]$window.Pid
    $owner = $processIndex[$ownerPid]
    $entry = [pscustomobject]@{
        handle = [long]$window.Handle
        pid = $ownerPid
        processName = if ($null -eq $owner) { $null } else { $owner.name }
        title = [string]$window.Title
        className = [string]$window.ClassName
        visible = [bool]$window.Visible
    }
    if (-not $entry.visible) {
        $matched = $false
        foreach ($marker in $windowTitleMarkers) {
            if ($entry.title -like "*$marker*") { $matched = $true; break }
        }
        if (-not $matched) { continue }
    }
    if ($windowsByOwner.ContainsKey($ownerPid)) {
        $windowsByOwner[$ownerPid] += $entry
    } else {
        $windowsByOwner[$ownerPid] = @($entry)
    }
}

$markerWindows = @(
    foreach ($window in $windowsByOwner.Values) {
        foreach ($candidateWindow in $window) {
            foreach ($marker in $windowTitleMarkers) {
                if ($marker.Length -gt 0 -and $candidateWindow.title -like "*$marker*") {
                    $candidateWindow
                    break
                }
            }
        }
    }
)

function Resolve-Ancestors {
    param([int]$ProcessId)

    $chain = @()
    $current = $processIndex[$ProcessId]
    $visited = @{}
    for ($depth = 0; $depth -lt 8 -and $null -ne $current; $depth++) {
        $parentId = [int]$current.parentPid
        if ($parentId -le 0 -or $visited.ContainsKey($parentId)) {
            break
        }
        $visited[$parentId] = $true
        $parent = $processIndex[$parentId]
        if ($null -eq $parent) {
            break
        }
        $chain += [pscustomobject]@{ pid = $parentId; name = $parent.name }
        $current = $parent
    }
    return $chain
}

$records = @(
    foreach ($process in $allProcesses) {
        $processId = [int]$process.ProcessId
        $processName = ConvertTo-NullableString $process.Name
        $processCommandLine = ConvertTo-NullableString $process.CommandLine
        $processBaseName = if ($null -eq $processName) {
            $null
        } else {
            $processName.Trim().ToLowerInvariant()
        }
        $candidate =
            ($processBaseName -match '^(?:node|codex|claude|dsh)(?:[-.]|$)') -or
            ($null -ne $processBaseName -and $includeNames -contains $processBaseName) -or
            ($processCommandLine -match $workingDirectoryPattern) -or
            # The watchdog's own process must always be reported so the caller
            # can derive the current user's SID even when its image name is not
            # a supported CLI (the packaged app runs it inside Selbstlauf.exe).
            ($includeProcessIds -contains $processId)
        if (-not $candidate) {
            continue
        }

        $ancestors = Resolve-Ancestors -ProcessId $processId
        $chainPids = @($ancestors | ForEach-Object { $_.pid })
        $chainWindows = @(
            foreach ($chainPid in $chainPids) {
                if ($windowsByOwner.ContainsKey($chainPid)) {
                    $windowsByOwner[$chainPid]
                }
            }
        )

        [pscustomobject]@{
            pid = $processId
            parentPid = [int]$process.ParentProcessId
            name = $processName
            commandLine = $processCommandLine
            executablePath = ConvertTo-NullableString $process.ExecutablePath
            creationDate = ConvertTo-NullableString $process.CreationDate
            userSid = Resolve-OwnerSid -Process $process -ProcessId $processId
            workingDirectory = Resolve-WorkingDirectory $processId
            ancestors = $ancestors
            windows = @($chainWindows + $markerWindows | Where-Object { $null -ne $_ })
        }
    }
)

ConvertTo-Json -InputObject $records -Compress -Depth 6
