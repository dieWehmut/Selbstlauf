param(
    [string[]]$IncludeExecutableName = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Selbstlauf.ProcessMetadata {
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
    param([object]$Process)

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

$records = @(
    foreach ($process in Get-WmiObject -Class Win32_Process) {
        $processName = ConvertTo-NullableString $process.Name
        $processCommandLine = ConvertTo-NullableString $process.CommandLine
        $processBaseName = if ($null -eq $processName) {
            $null
        } else {
            $processName.Trim().ToLowerInvariant()
        }
        $candidate =
            ($processBaseName -match '^(?:node|codex|claude)(?:[-.]|$)') -or
            ($null -ne $processBaseName -and $includeNames -contains $processBaseName) -or
            $processCommandLine -match '(?i)(?:claude-code|claude\.ps1|@openai[\\/]codex|codex\.js|codex\.exe)'
        if (-not $candidate) {
            continue
        }

        [pscustomobject]@{
            pid = [int]$process.ProcessId
            parentPid = [int]$process.ParentProcessId
            name = $processName
            commandLine = $processCommandLine
            executablePath = ConvertTo-NullableString $process.ExecutablePath
            creationDate = ConvertTo-NullableString $process.CreationDate
            userSid = Resolve-OwnerSid $process
            workingDirectory = Resolve-WorkingDirectory ([int]$process.ProcessId)
        }
    }
)

ConvertTo-Json -InputObject $records -Compress
