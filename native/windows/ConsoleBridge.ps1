[CmdletBinding()]
param(
    [switch]$SelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

namespace AiCliBypass.Native {
    public static class ConsoleBridgeNative {
        public const ushort KeyEvent = 0x0001;
        public const uint GenericRead = 0x80000000;
        public const uint GenericWrite = 0x40000000;
        public const uint FileShareRead = 0x00000001;
        public const uint FileShareWrite = 0x00000002;
        public const uint OpenExisting = 3;
        public static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        public struct Coord {
            public short X;
            public short Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SmallRect {
            public short Left;
            public short Top;
            public short Right;
            public short Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ConsoleScreenBufferInfo {
            public Coord Size;
            public Coord CursorPosition;
            public ushort Attributes;
            public SmallRect Window;
            public Coord MaximumWindowSize;
        }

        [StructLayout(LayoutKind.Explicit, Size = 16, CharSet = CharSet.Unicode)]
        public struct KeyEventRecord {
            [FieldOffset(0)] public int KeyDown;
            [FieldOffset(4)] public ushort RepeatCount;
            [FieldOffset(6)] public ushort VirtualKeyCode;
            [FieldOffset(8)] public ushort VirtualScanCode;
            [FieldOffset(10)] public char UnicodeChar;
            [FieldOffset(12)] public uint ControlKeyState;
        }

        [StructLayout(LayoutKind.Explicit, Size = 20)]
        public struct InputRecord {
            [FieldOffset(0)] public ushort EventType;
            [FieldOffset(4)] public KeyEventRecord KeyEvent;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool FreeConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AttachConsole(uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint GetCurrentProcessId();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint GetConsoleProcessList(
            [Out] uint[] processList,
            uint processCount);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool WriteConsoleInputW(
            IntPtr consoleInput,
            [In] InputRecord[] records,
            uint recordCount,
            out uint recordsWritten);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ReadConsoleOutputCharacterW(
            IntPtr consoleOutput,
            [Out] char[] characters,
            uint characterCount,
            Coord readCoordinate,
            out uint charactersRead);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetConsoleScreenBufferInfo(
            IntPtr consoleOutput,
            out ConsoleScreenBufferInfo info);

        public static InputRecord[] CreateTextRecords(string text) {
            if (String.IsNullOrEmpty(text)) {
                throw new ArgumentException("Text must not be empty.", "text");
            }

            var records = new InputRecord[(text.Length + 1) * 2];
            var index = 0;
            foreach (var character in text) {
                records[index++] = CreateKeyRecord(character, 0, 0, true);
                records[index++] = CreateKeyRecord(character, 0, 0, false);
            }
            records[index++] = CreateKeyRecord('\r', 0x000D, 0x001C, true);
            records[index++] = CreateKeyRecord('\r', 0x000D, 0x001C, false);
            return records;
        }

        private static InputRecord CreateKeyRecord(
            char character,
            ushort virtualKeyCode,
            ushort virtualScanCode,
            bool keyDown) {
            var record = new InputRecord();
            record.EventType = KeyEvent;
            record.KeyEvent = new KeyEventRecord {
                KeyDown = keyDown ? 1 : 0,
                RepeatCount = 1,
                VirtualKeyCode = virtualKeyCode,
                VirtualScanCode = virtualScanCode,
                UnicodeChar = character,
                ControlKeyState = 0,
            };
            return record;
        }
    }
}
'@

$null = Add-Type -TypeDefinition $nativeSource -Language CSharp

function New-BridgeFailure {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Command,
        [Parameter(Mandatory = $true)][long]$TargetProcessId,
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message,
        [Nullable[int]]$NativeErrorCode
    )

    $errorValue = [ordered]@{
        code = $Code
        message = $Message
    }
    if ($null -ne $NativeErrorCode) {
        $errorValue.nativeErrorCode = [int]$NativeErrorCode
    }
    return [pscustomobject][ordered]@{
        ok = $false
        kind = 'cannot-inject'
        command = $Command
        pid = $TargetProcessId
        error = [pscustomobject]$errorValue
    }
}

function New-BridgeSuccess {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][long]$TargetProcessId,
        [Parameter(Mandatory = $true)]$Properties
    )

    $value = [ordered]@{
        ok = $true
        kind = 'classic-console'
        command = $Command
        pid = $TargetProcessId
    }
    foreach ($property in $Properties.PSObject.Properties) {
        $value[$property.Name] = $property.Value
    }
    return [pscustomobject]$value
}

function Get-RequestCommand {
    param([Parameter(Mandatory = $true)]$Request)

    $property = $Request.PSObject.Properties['command']
    if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
        return $null
    }
    return ([string]$property.Value).Trim().ToLowerInvariant()
}

function Get-RequestPid {
    param([Parameter(Mandatory = $true)]$Request)

    $property = $Request.PSObject.Properties['pid']
    if ($null -eq $property) {
        return [pscustomobject]@{ Ok = $false; Value = 0; Error = 'Request did not contain a PID.' }
    }

    [uint32]$targetProcessId = 0
    $parsed = [uint32]::TryParse(
        [string]$property.Value,
        [Globalization.NumberStyles]::Integer,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$targetProcessId
    )
    if (-not $parsed -or $targetProcessId -eq 0) {
        return [pscustomobject]@{ Ok = $false; Value = 0; Error = 'PID must be a positive 32-bit process ID.' }
    }
    return [pscustomobject]@{ Ok = $true; Value = $targetProcessId; Error = $null }
}

function Get-RequestText {
    param([Parameter(Mandatory = $true)]$Request)

    $property = $Request.PSObject.Properties['text']
    if ($null -eq $property -or $null -eq $property.Value) {
        return [pscustomobject]@{ Ok = $false; Value = ''; Error = 'Write request did not contain text.' }
    }
    $text = [string]$property.Value
    if ([string]::IsNullOrEmpty($text) -or $text.IndexOfAny(@([char]0, [char]13, [char]10)) -ge 0) {
        return [pscustomobject]@{ Ok = $false; Value = ''; Error = 'Text must be non-empty and single-line.' }
    }
    return [pscustomobject]@{ Ok = $true; Value = $text; Error = $null }
}

function Get-ConsoleProcessIds {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][long]$TargetProcessId
    )

    [uint32[]]$initial = New-Object 'System.UInt32[]' 1
    [uint32]$count = [AiCliBypass.Native.ConsoleBridgeNative]::GetConsoleProcessList($initial, 1)
    if ($count -eq 0) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        return [pscustomobject]@{ Ok = $false; Ids = @(); Failure = (New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'process-list-failed' -Message 'GetConsoleProcessList failed.' -NativeErrorCode $nativeError) }
    }

    [uint32[]]$processIds = $initial
    if ($count -gt $initial.Length) {
        $processIds = New-Object 'System.UInt32[]' ([int]$count)
        [uint32]$secondCount = [AiCliBypass.Native.ConsoleBridgeNative]::GetConsoleProcessList($processIds, $count)
        if ($secondCount -eq 0 -or $secondCount -gt $processIds.Length) {
            $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            return [pscustomobject]@{ Ok = $false; Ids = @(); Failure = (New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'process-list-failed' -Message 'GetConsoleProcessList returned an invalid process list.' -NativeErrorCode $nativeError) }
        }
        $count = $secondCount
    }

    $ids = @($processIds | Select-Object -First ([int]$count) | ForEach-Object { [uint32]$_ })
    $targetFound = $false
    foreach ($processId in $ids) {
        if ([uint32]$processId -eq [uint32]$TargetProcessId) {
            $targetFound = $true
            break
        }
    }
    if (-not $targetFound) {
        return [pscustomobject]@{ Ok = $false; Ids = @(); Failure = (New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'target-not-in-console' -Message 'The attached console did not contain the requested PID.') }
    }

    $bridgeProcessId = [AiCliBypass.Native.ConsoleBridgeNative]::GetCurrentProcessId()
    $filteredIds = @($ids | Where-Object { [uint32]$_ -ne $bridgeProcessId })
    return [pscustomobject]@{ Ok = $true; Ids = $filteredIds; Failure = $null }
}

function Open-ConsoleHandle {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][long]$TargetProcessId,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][uint32]$Access,
        [Parameter(Mandatory = $true)][string]$FailureCode,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $handle = [AiCliBypass.Native.ConsoleBridgeNative]::CreateFileW(
        $Name,
        $Access,
        [AiCliBypass.Native.ConsoleBridgeNative]::FileShareRead -bor [AiCliBypass.Native.ConsoleBridgeNative]::FileShareWrite,
        [IntPtr]::Zero,
        [AiCliBypass.Native.ConsoleBridgeNative]::OpenExisting,
        0,
        [IntPtr]::Zero
    )
    if ($handle -eq [IntPtr]::Zero -or $handle -eq [AiCliBypass.Native.ConsoleBridgeNative]::InvalidHandleValue) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        return [pscustomobject]@{
            Ok = $false
            Handle = [IntPtr]::Zero
            Failure = (New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code $FailureCode -Message $FailureMessage -NativeErrorCode $nativeError)
        }
    }
    return [pscustomobject]@{ Ok = $true; Handle = $handle; Failure = $null }
}

function Write-ConsoleText {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][long]$TargetProcessId,
        [Parameter(Mandatory = $true)][string]$Text
    )

    $opened = Open-ConsoleHandle -Command $Command -TargetProcessId $TargetProcessId -Name 'CONIN$' -Access ([AiCliBypass.Native.ConsoleBridgeNative]::GenericWrite) -FailureCode 'open-console-input-failed' -FailureMessage 'Could not open the target console input buffer.'
    if (-not $opened.Ok) { return $opened.Failure }

    try {
        $records = [AiCliBypass.Native.ConsoleBridgeNative]::CreateTextRecords($Text)
        [uint32]$written = 0
        $success = [AiCliBypass.Native.ConsoleBridgeNative]::WriteConsoleInputW($opened.Handle, $records, [uint32]$records.Length, [ref]$written)
        if (-not $success) {
            $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'write-failed' -Message 'WriteConsoleInputW failed.' -NativeErrorCode $nativeError
        }
        if ($written -ne $records.Length) {
            return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'write-partial' -Message 'WriteConsoleInputW wrote only part of the requested sequence.'
        }
        return New-BridgeSuccess -Command $Command -TargetProcessId $TargetProcessId -Properties ([pscustomobject]@{ recordsWritten = [int]$written })
    }
    catch {
        return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'write-failed' -Message $_.Exception.Message
    }
    finally {
        $null = [AiCliBypass.Native.ConsoleBridgeNative]::CloseHandle($opened.Handle)
    }
}

function Get-ConsoleSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][long]$TargetProcessId
    )

    $opened = Open-ConsoleHandle -Command $Command -TargetProcessId $TargetProcessId -Name 'CONOUT$' -Access ([AiCliBypass.Native.ConsoleBridgeNative]::GenericRead) -FailureCode 'open-console-output-failed' -FailureMessage 'Could not open the target console screen buffer.'
    if (-not $opened.Ok) { return $opened.Failure }

    try {
        $info = New-Object -TypeName 'AiCliBypass.Native.ConsoleBridgeNative+ConsoleScreenBufferInfo'
        $success = [AiCliBypass.Native.ConsoleBridgeNative]::GetConsoleScreenBufferInfo($opened.Handle, [ref]$info)
        if (-not $success) {
            $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'snapshot-failed' -Message 'GetConsoleScreenBufferInfo failed.' -NativeErrorCode $nativeError
        }

        $left = [int]$info.Window.Left
        $top = [int]$info.Window.Top
        $right = [int]$info.Window.Right
        $bottom = [int]$info.Window.Bottom
        $width = $right - $left + 1
        $height = $bottom - $top + 1
        if ($width -le 0 -or $height -le 0 -or ([long]$width * [long]$height) -gt 4194304) {
            return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'snapshot-size' -Message 'The target console screen buffer has unsafe dimensions.'
        }

        $builder = New-Object System.Text.StringBuilder
        for ($row = 0; $row -lt $height; $row++) {
            [char[]]$characters = New-Object char[] $width
            [uint32]$charactersRead = 0
            $coordinate = New-Object -TypeName 'AiCliBypass.Native.ConsoleBridgeNative+Coord'
            $coordinate.X = [int16]$left
            $coordinate.Y = [int16]($top + $row)
            $rowSuccess = [AiCliBypass.Native.ConsoleBridgeNative]::ReadConsoleOutputCharacterW($opened.Handle, $characters, [uint32]$width, $coordinate, [ref]$charactersRead)
            if (-not $rowSuccess) {
                $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'snapshot-failed' -Message 'ReadConsoleOutputCharacterW failed.' -NativeErrorCode $nativeError
            }
            if ($charactersRead -gt 0) {
                $null = $builder.Append($characters, 0, [int]$charactersRead)
            }
            $null = $builder.Append([char]10)
        }

        $material = '{0},{1},{2},{3},{4},{5},{6},{7}`n{8}' -f $left, $top, $right, $bottom, [int]$info.CursorPosition.X, [int]$info.CursorPosition.Y, $width, $height, $builder.ToString()
        $sha = New-Object System.Security.Cryptography.SHA256Managed
        try {
            $digest = $sha.ComputeHash($utf8.GetBytes($material))
        }
        finally {
            $sha.Dispose()
        }
        $fingerprint = ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
        return New-BridgeSuccess -Command $Command -TargetProcessId $TargetProcessId -Properties ([pscustomobject]@{ fingerprint = $fingerprint })
    }
    catch {
        return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'snapshot-failed' -Message $_.Exception.Message
    }
    finally {
        $null = [AiCliBypass.Native.ConsoleBridgeNative]::CloseHandle($opened.Handle)
    }
}

function Invoke-AttachedRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][long]$TargetProcessId,
        [Parameter(Mandatory = $true)]$Request
    )

    $null = [AiCliBypass.Native.ConsoleBridgeNative]::FreeConsole()
    $attached = [AiCliBypass.Native.ConsoleBridgeNative]::AttachConsole([uint32]$TargetProcessId)
    if (-not $attached) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'attach-failed' -Message 'AttachConsole failed.' -NativeErrorCode $nativeError
    }

    try {
        $processList = Get-ConsoleProcessIds -Command $Command -TargetProcessId $TargetProcessId
        if (-not $processList.Ok) { return $processList.Failure }

        switch ($Command) {
            'probe' {
                return New-BridgeSuccess -Command $Command -TargetProcessId $TargetProcessId -Properties ([pscustomobject]@{ consoleProcessIds = @($processList.Ids) })
            }
            'snapshot' {
                return Get-ConsoleSnapshot -Command $Command -TargetProcessId $TargetProcessId
            }
            'write' {
                $text = Get-RequestText -Request $Request
                if (-not $text.Ok) { return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'invalid-text' -Message $text.Error }
                return Write-ConsoleText -Command $Command -TargetProcessId $TargetProcessId -Text $text.Value
            }
            default {
                return New-BridgeFailure -Command $Command -TargetProcessId $TargetProcessId -Code 'invalid-command' -Message 'Unsupported bridge command.'
            }
        }
    }
    finally {
        $null = [AiCliBypass.Native.ConsoleBridgeNative]::FreeConsole()
    }
}

function Write-BridgeResponse {
    param([Parameter(Mandatory = $true)]$Value)

    $json = $Value | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

if ($SelfTest) {
    $sample = ([char]0x7ee7).ToString() + ([char]0x7eed).ToString()
    $records = [AiCliBypass.Native.ConsoleBridgeNative]::CreateTextRecords($sample)
    $selfTestInfo = New-Object -TypeName 'AiCliBypass.Native.ConsoleBridgeNative+ConsoleScreenBufferInfo'
    $selfTestCoordinate = New-Object -TypeName 'AiCliBypass.Native.ConsoleBridgeNative+Coord'
    if ($null -eq $selfTestInfo -or $null -eq $selfTestCoordinate) { throw 'Self-test could not construct console structures.' }
    if ($records.Length -ne 6) { throw 'Self-test expected one key sequence and Enter.' }
    if ($records[0].EventType -ne [AiCliBypass.Native.ConsoleBridgeNative]::KeyEvent -or
        $records[1].KeyEvent.KeyDown -ne 0 -or
        $records[2].KeyEvent.UnicodeChar -ne $sample[1]) {
        throw 'Self-test found an invalid Unicode key sequence.'
    }
    if ($records[4].KeyEvent.VirtualKeyCode -ne 0x000D -or
        $records[4].KeyEvent.VirtualScanCode -ne 0x001C -or
        $records[5].KeyEvent.KeyDown -ne 0 -or
        $records[4].KeyEvent.UnicodeChar -ne [char]13) {
        throw 'Self-test found an invalid Enter sequence.'
    }
    [Console]::Out.WriteLine('ConsoleBridge self-test passed')
    exit 0
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $request = $null
    try {
        $request = $line | ConvertFrom-Json
    }
    catch {
        Write-BridgeResponse (New-BridgeFailure -Command 'unknown' -TargetProcessId 0 -Code 'invalid-request' -Message 'Request was not valid JSON.')
        continue
    }
    if ($null -eq $request) {
        Write-BridgeResponse (New-BridgeFailure -Command 'unknown' -TargetProcessId 0 -Code 'invalid-request' -Message 'Request was empty.')
        continue
    }

    $command = Get-RequestCommand -Request $request
    $pidResult = Get-RequestPid -Request $request
    if ($null -eq $command -or @('probe', 'snapshot', 'write') -notcontains $command) {
        Write-BridgeResponse (New-BridgeFailure -Command ([string]$command) -TargetProcessId 0 -Code 'invalid-command' -Message 'Command must be probe, snapshot, or write.')
        continue
    }
    if (-not $pidResult.Ok) {
        Write-BridgeResponse (New-BridgeFailure -Command $command -TargetProcessId 0 -Code 'invalid-pid' -Message $pidResult.Error)
        continue
    }
    if ($command -eq 'write') {
        $textResult = Get-RequestText -Request $request
        if (-not $textResult.Ok) {
            Write-BridgeResponse (New-BridgeFailure -Command $command -TargetProcessId $pidResult.Value -Code 'invalid-text' -Message $textResult.Error)
            continue
        }
    }

    try {
        Write-BridgeResponse (Invoke-AttachedRequest -Command $command -TargetProcessId $pidResult.Value -Request $request)
    }
    catch {
        Write-BridgeResponse (New-BridgeFailure -Command $command -TargetProcessId $pidResult.Value -Code 'bridge-failure' -Message $_.Exception.Message)
    }
}
