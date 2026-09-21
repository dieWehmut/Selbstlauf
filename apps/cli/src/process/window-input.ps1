param(
    [Parameter(Mandatory = $true)][int]$Handle,
    [Parameter(Mandatory = $true)][ValidateSet('probe', 'type')][string]$Mode,
    [string]$SubmitKey = '',
    [int]$FocusSettleMs = 700
)

# Typing into a window, and putting the user's focus back.
#
# Measured in this session, and the reason this helper is shaped the way it is:
#
#   PostMessage(WM_CHAR) into a background window   -> delivers NOTHING
#   SendInput                                       -> delivers, but only to the FOREGROUND window
#   SetForegroundWindow from a background process   -> returns False (Windows' foreground lock)
#   AttachThreadInput + SetFocus                    -> works, and VISIBLY TAKES FOCUS
#   UI Automation ValuePattern                      -> its child controls are absent from the automation tree
#                                                      while the window is minimized
#
# So the only route that delivers input has to take the foreground first. The user chose that trade explicitly,
# knowing focus is stolen; what this script must never do is compound it by typing into the WRONG window. Every
# keystroke is therefore gated on having confirmed that the target really is the foreground window — if focus
# cannot be taken, nothing is typed at all and the reason is reported.
#
# The text arrives on STDIN as UTF-8, never as an argument. Measured repeatedly in this project: a `-File`
# parameter cannot bind an array, cannot bind a Boolean, and mangles non-ASCII through the console code page.
# stdin avoids every one of those failures.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Typist
{
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const ushort VK_RETURN = 0x0D;
    public const ushort VK_TAB = 0x09;
    public const int SW_RESTORE = 9;

    public static string Title(IntPtr hWnd)
    {
        var sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, 512);
        return sb.ToString();
    }

    /**
     * One unicode character, down and up, exactly as a keyboard delivers it.
     *
     * The batch form measured badly and this is why it is not used: `SendInput` with the whole string in one
     * array delivered only the first five characters of a 20-character line, and a tight loop of per-character
     * sends delivered the same five — the target control's message queue cannot keep up with input arriving
     * faster than it processes. Typing one character at a time with a pause between them delivered the full
     * string, so the caller drives the pace and this stays a single keystroke.
     */
    public static uint TypeCharacter(char c)
    {
        var list = new INPUT[2];
        list[0] = Key(c, false);
        list[1] = Key(c, true);
        return SendInput((uint)list.Length, list, Marshal.SizeOf(typeof(INPUT)));
    }

    /** A virtual key press, for Enter or Tab. */
    public static uint PressKey(ushort vk)
    {
        var list = new INPUT[2];
        list[0] = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = 0, time = 0, dwExtraInfo = IntPtr.Zero } } };
        list[1] = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero } } };
        return SendInput((uint)list.Length, list, Marshal.SizeOf(typeof(INPUT)));
    }

    private static INPUT Key(char c, bool up)
    {
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            U = new InputUnion
            {
                ki = new KEYBDINPUT
                {
                    wVk = 0, wScan = c,
                    dwFlags = up ? KEYEVENTF_UNICODE | KEYEVENTF_KEYUP : KEYEVENTF_UNICODE,
                    time = 0, dwExtraInfo = IntPtr.Zero,
                },
            },
        };
    }

    /**
     * Take the foreground, using the only method that works from a background process.
     *
     * AttachThreadInput joins this thread's input queue to the current foreground window's so SetForegroundWindow
     * and SetFocus are permitted; it is detached again immediately so the queues do not stay joined.
     */
    public static bool TakeForeground(IntPtr hWnd)
    {
        if (GetForegroundWindow() == hWnd) return true;
        if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
        BringWindowToTop(hWnd);

        uint unused;
        uint targetThread = GetWindowThreadProcessId(hWnd, out unused);
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out unused);
        uint ours = GetCurrentThreadId();

        bool attachedToForeground = false;
        bool attachedToTarget = false;
        try
        {
            if (foregroundThread != 0 && foregroundThread != ours) attachedToForeground = AttachThreadInput(ours, foregroundThread, true);
            if (targetThread != 0 && targetThread != ours) attachedToTarget = AttachThreadInput(ours, targetThread, true);
            SetForegroundWindow(hWnd);
            SetFocus(hWnd);
        }
        finally
        {
            if (attachedToTarget) AttachThreadInput(ours, targetThread, false);
            if (attachedToForeground) AttachThreadInput(ours, foregroundThread, false);
        }
        return GetForegroundWindow() == hWnd;
    }
}
'@

function Write-Result {
    param([hashtable]$Fields)
    $ordered = [ordered]@{}
    foreach ($key in $Fields.Keys) { $ordered[$key] = $Fields[$key] }
    ConvertTo-Json -InputObject $ordered -Compress
}

# The text is read from stdin as UTF-8, never from an argument.
$stdinText = ''
if ($Mode -eq 'type') {
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
    $stdinText = $reader.ReadToEnd()
    $reader.Dispose()
}

if ($Handle -le 0) {
    Write-Result @{ ok = $false; reason = 'invalid-window-handle' }
    exit 0
}

$window = [IntPtr]$Handle
if (-not [Typist]::IsWindow($window)) {
    Write-Result @{ ok = $false; reason = 'window-not-found' }
    exit 0
}

$foregroundBefore = [Typist]::GetForegroundWindow()
$wasMinimized = [Typist]::IsIconic($window)
$title = [Typist]::Title($window)

if ($Mode -eq 'probe') {
    # A read-only answer: can this window be focused at all, and what is it?
    Write-Result @{
        ok              = $true
        title           = $title
        wasMinimized    = $wasMinimized
        isForeground    = ($foregroundBefore -eq $window)
        foregroundBefore = $foregroundBefore.ToInt64()
    }
    exit 0
}

# --- type -----------------------------------------------------------------------------------------
if ($stdinText.Length -eq 0) {
    Write-Result @{ ok = $false; reason = 'empty-text'; title = $title }
    exit 0
}

$took = [Typist]::TakeForeground($window)
Start-Sleep -Milliseconds $FocusSettleMs

# THE GATE. Nothing is typed unless the target really is the foreground window, because SendInput goes to
# whatever holds focus — typing without this check would put the text into an unrelated application.
$confirmed = ([Typist]::GetForegroundWindow() -eq $window)
if (-not $took -or -not $confirmed) {
    # Put the user's focus back even though nothing was typed.
    if ($foregroundBefore -ne [IntPtr]::Zero) { [void][Typist]::SetForegroundWindow($foregroundBefore) }
    Write-Result @{
        ok       = $false
        reason   = 'could-not-take-focus'
        title    = $title
        typed    = 0
        note     = 'nothing was typed, so no other window received the text'
    }
    exit 0
}

$typed = 0
$sentInputs = 0
foreach ($ch in $stdinText.ToCharArray()) {
    $sentInputs += [Typist]::TypeCharacter($ch)
    $typed++
    # The pause is not cosmetic. Measured: sending a whole line faster than the target processes it delivers
    # only the first few characters, and the loss is silent — the API still reports every input as sent.
    Start-Sleep -Milliseconds 25
}
$submitted = $false
if ($SubmitKey -eq 'enter') {
    Start-Sleep -Milliseconds 150
    [void][Typist]::PressKey([Typist]::VK_RETURN)
    $submitted = $true
} elseif ($SubmitKey -eq 'tab') {
    Start-Sleep -Milliseconds 150
    [void][Typist]::PressKey([Typist]::VK_TAB)
    $submitted = $true
}

Start-Sleep -Milliseconds 200

# Give the user their focus back. This is the cost of the route, and it is paid back immediately.
$restored = $false
if ($foregroundBefore -ne [IntPtr]::Zero -and $foregroundBefore -ne $window) {
    $restored = [Typist]::TakeForeground($foregroundBefore)
}
if ($wasMinimized -and -not $restored) {
    # A window the user was not looking at is left minimized again rather than left stealing the screen.
    [void][Typist]::ShowWindow($window, 6)
}

Write-Result @{
    ok               = $true
    title            = $title
    typed            = $typed
    sentInputs       = $typed
    submitted        = $submitted
    wasMinimized     = $wasMinimized
    foregroundBefore = $foregroundBefore.ToInt64()
    foregroundAfter  = [Typist]::GetForegroundWindow().ToInt64()
    focusRestored    = $restored
}