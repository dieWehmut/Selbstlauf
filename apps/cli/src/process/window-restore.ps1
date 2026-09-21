param(
    [Parameter(Mandatory = $true)][int]$Handle,
    [Parameter(Mandatory = $true)][ValidateSet('show', 'minimize')][string]$Mode,
    [int]$SettleMs = 800,
    # Set by the caller when undoing a `show`: it is the caller's record that this window was restored, so
    # the undo never has to guess. See the `minimize` branch for why guessing got it backwards.
    #
    # A `[string]`, not `[bool]`, for the same reason the window-title markers are: under `-File`, arguments
    # arrive as literal strings and PowerShell refuses to convert one to a Boolean — measured, `-Flag $true`,
    # `-Flag 1` and `-Flag true` are all rejected with "Boolean parameters accept only Boolean values and
    # numbers". A string compared in the script is the form that works.
    [string]$WasMinimized = 'false'
)

# Anything other than an explicit true is read as false, so a missing or malformed flag can never cause the
# undo to act on a window the caller did not restore.
$undoRestore = $WasMinimized.Trim().ToLowerInvariant() -in @('true', '1', 'yes', '$true')

# Window state for capturing a MINIMIZED window's contents.
#
# Why this exists: Electron's `desktopCapturer` does not enumerate a minimized window at all — measured, the
# window is absent from `getSources` while minimized and reappears once shown. `PrintWindow` is no help
# either: rendered at the window's restore size it comes back flat, because a minimized window has no
# rendered surface at all. So the only way to show what is inside one is to let it render once, capture, and
# minimize it again.
#
# `-Mode show` uses SW_SHOWNOACTIVATE, which maps the window **without taking focus**, so a preview never
# steals the caret from whatever the user is typing into. `-Mode minimize` puts it back with
# SW_SHOWMINNOACTIVE, which minimizes without activating — so the window returns to exactly the state it was
# found in and the foreground window is left alone.
#
# This script reports state only. It captures nothing and never touches keyboard or mouse input.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PreviewWindow
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT minPosition;
        public POINT maxPosition;
        public RECT normalPosition;
    }

    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public const int SW_SHOWNOACTIVATE = 4;
    public const int SW_SHOWMINNOACTIVE = 7;

    public static WINDOWPLACEMENT Placement(IntPtr hWnd)
    {
        var placement = new WINDOWPLACEMENT();
        placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        GetWindowPlacement(hWnd, ref placement);
        return placement;
    }
}
'@

function Write-Result {
    param([hashtable]$Fields)
    $ordered = [ordered]@{}
    foreach ($key in $Fields.Keys) { $ordered[$key] = $Fields[$key] }
    ConvertTo-Json -InputObject $ordered -Compress
}

if ($Handle -le 0) {
    Write-Result @{ ok = $false; reason = 'invalid-window-handle' }
    exit 0
}

$window = [IntPtr]$Handle
if (-not [PreviewWindow]::IsWindow($window)) {
    Write-Result @{ ok = $false; reason = 'window-not-found' }
    exit 0
}

$wasMinimized = [PreviewWindow]::IsIconic($window)
$foregroundBefore = [PreviewWindow]::GetForegroundWindow().ToInt64()

switch ($Mode) {
    'show' {
        # Only meaningful for a minimized window: anything else is already rendering.
        $changed = $false
        if ($wasMinimized) {
            [void][PreviewWindow]::ShowWindow($window, [PreviewWindow]::SW_SHOWNOACTIVATE)
            Start-Sleep -Milliseconds $SettleMs
            $changed = $true
        }
        $placement = [PreviewWindow]::Placement($window)
        Write-Result @{
            ok               = $true
            changed          = $changed
            wasMinimized     = $wasMinimized
            nowMinimized     = [PreviewWindow]::IsIconic($window)
            visible          = [PreviewWindow]::IsWindowVisible($window)
            foregroundBefore = $foregroundBefore
            foregroundAfter  = [PreviewWindow]::GetForegroundWindow().ToInt64()
            renderWidth      = $placement.normalPosition.Right - $placement.normalPosition.Left
            renderHeight     = $placement.normalPosition.Bottom - $placement.normalPosition.Top
        }
    }
    'minimize' {
        # Undo a previous `show`, and ONLY that.
        #
        # `-WasMinimized` is how the caller says "this is a window I restored", which is the only state a
        # preview may leave behind. It must not be inferred from the window here: the first version did that
        # and got it exactly backwards — it minimized a window that was NOT minimized, so a preview of an
        # ordinary open window whose first capture happened to fail would minimize the window the user was
        # looking at. Asking the caller removes the guess entirely.
        $changed = $false
        if ($undoRestore) {
            [void][PreviewWindow]::ShowWindow($window, [PreviewWindow]::SW_SHOWMINNOACTIVE)
            Start-Sleep -Milliseconds 300
            $changed = $true
        }
        Write-Result @{
            ok               = $true
            changed          = $changed
            nowMinimized     = [PreviewWindow]::IsIconic($window)
            visible          = [PreviewWindow]::IsWindowVisible($window)
            foregroundBefore = $foregroundBefore
            foregroundAfter  = [PreviewWindow]::GetForegroundWindow().ToInt64()
        }
    }
}