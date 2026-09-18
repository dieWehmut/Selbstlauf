param(
    [long]$Handle = 0,
    [int]$ProcessId = 0,
    [string]$OpenUrl = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Selbstlauf.WindowFocus {
    public static class Activator {
        private const int SW_RESTORE = 9;
        private const int SW_SHOW = 5;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private static readonly IntPtr HWND_TOP = new IntPtr(0);
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int command);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);

        [DllImport("user32.dll")]
        private static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
        }

        [DllImport("user32.dll")]
        private static extern bool PeekMessage(out MSG message, IntPtr hWnd, uint min, uint max, uint remove);

        /// <summary>
        /// Give this thread a message queue. AttachThreadInput cannot join a
        /// thread that has none, and without the join Windows refuses the
        /// foreground change to a process that did not receive the last input.
        /// </summary>
        private static void EnsureMessageQueue() {
            MSG message;
            PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
        }

        /// <summary>
        /// Restore and raise one window. No keyboard or mouse input is ever
        /// synthesized: an attached input queue only satisfies the foreground
        /// lock, and it is detached again before returning.
        /// </summary>
        public static string Activate(IntPtr handle) {
            if (!IsWindow(handle)) {
                return "window-not-found";
            }
            if (IsIconic(handle)) {
                ShowWindow(handle, SW_RESTORE);
            } else if (!IsWindowVisible(handle)) {
                ShowWindow(handle, SW_SHOW);
            }
            SetWindowPos(handle, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(handle);
            SetForegroundWindow(handle);
            if (GetForegroundWindow() == handle) {
                return null;
            }

            IntPtr foreground = GetForegroundWindow();
            if (foreground != IntPtr.Zero) {
                uint owner;
                uint foregroundThread = GetWindowThreadProcessId(foreground, out owner);
                uint currentThread = GetCurrentThreadId();
                if (foregroundThread != currentThread) {
                    EnsureMessageQueue();
                    bool attached = false;
                    try {
                        attached = AttachThreadInput(currentThread, foregroundThread, true);
                        BringWindowToTop(handle);
                        SetWindowPos(handle, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                        SetForegroundWindow(handle);
                    } finally {
                        if (attached) {
                            AttachThreadInput(currentThread, foregroundThread, false);
                        }
                    }
                }
            }
            if (GetForegroundWindow() == handle) {
                return null;
            }

            // Last resort: the window manager's own activation path, the one
            // Alt-Tab uses. Still window management, never synthesized input.
            SwitchToThisWindow(handle, true);
            if (GetForegroundWindow() == handle) {
                return null;
            }

            // Windows refuses the foreground change to a process that did not
            // receive the last input. Raise the window to the top of the
            // z-order instead so it is at least plainly visible, then drop the
            // topmost flag again so it does not stay pinned over everything.
            SetWindowPos(handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetWindowPos(handle, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            if (!IsWindowVisible(handle)) {
                return "window-not-showable";
            }
            return "foreground-refused";
        }

        public static string Describe(IntPtr handle) {
            StringBuilder title = new StringBuilder(512);
            GetWindowTextW(handle, title, title.Capacity);
            return title.ToString();
        }

        public static int Owner(IntPtr handle) {
            uint pid;
            GetWindowThreadProcessId(handle, out pid);
            return (int)pid;
        }
    }
}
'@

function Write-Result {
    param([bool]$Ok, [bool]$Focused, [string]$Reason, [string]$Title, [int]$Owner)

    [pscustomobject]@{
        ok = $Ok
        focused = $Focused
        reason = $Reason
        title = $Title
        processId = $Owner
    } | ConvertTo-Json -Compress
}

if ($OpenUrl.Length -gt 0) {
    $uri = $null
    if (-not [System.Uri]::TryCreate($OpenUrl, [System.UriKind]::Absolute, [ref]$uri) -or
        ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https')) {
        Write-Result -Ok $false -Focused $false -Reason 'unsupported-url' -Title '' -Owner 0
        exit 0
    }
    Start-Process -FilePath $uri.AbsoluteUri | Out-Null
    Write-Result -Ok $true -Focused $true -Reason '' -Title $uri.AbsoluteUri -Owner 0
    exit 0
}

if ($Handle -le 0) {
    if ($ProcessId -le 0) {
        Write-Result -Ok $false -Focused $false -Reason 'missing-target' -Title '' -Owner 0
        exit 0
    }
    Write-Result -Ok $false -Focused $false -Reason 'process-focus-not-supported' -Title '' -Owner $ProcessId
    exit 0
}

$window = [IntPtr]::new($Handle)
$reason = [Selbstlauf.WindowFocus.Activator]::Activate($window)
$title = [Selbstlauf.WindowFocus.Activator]::Describe($window)
$owner = [Selbstlauf.WindowFocus.Activator]::Owner($window)
# "foreground-refused" still raised the window: only a window that could not be
# shown at all is a failure.
$shown = $null -eq $reason -or $reason -eq 'foreground-refused'
Write-Result -Ok $shown -Focused ($null -eq $reason) -Reason ([string]$reason) -Title $title -Owner $owner