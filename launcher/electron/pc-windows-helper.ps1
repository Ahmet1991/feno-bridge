param(
    [Parameter(Mandatory=$true)][string]$PayloadBase64
)

# Fixed, packaged helper: model input is JSON data, never PowerShell source.
$ErrorActionPreference = 'Stop'
# The MCP process decodes stdout as UTF-8; legacy console code pages corrupt HWND identity titles.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PcWinApi {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr param);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr param);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError=true)] public static extern bool AttachThreadInput(uint caller, uint other, bool attach);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder buffer, int length, out int needed);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);

    public static string ReadProcessName(uint processId) {
        using (var process = System.Diagnostics.Process.GetProcessById((int)processId))
            return process.ProcessName + ".exe";
    }

    // UWP Calculator's visible frame belongs to the shared Windows host. Resolve
    // only its own CoreWindow child; never authorize the shared host itself.
    public static uint ResolveWindowProcessId(IntPtr hwnd) {
        uint owner;
        GetWindowThreadProcessId(hwnd, out owner);
        if (!String.Equals(ReadProcessName(owner), "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) return owner;
        var children = new System.Collections.Generic.HashSet<uint>();
        bool failed = false;
        EnumWindowsProc callback = delegate(IntPtr child, IntPtr unused) {
            try {
                var name = new StringBuilder(256);
                GetClassName(child, name, 256);
                if (name.ToString() != "Windows.UI.Core.CoreWindow") return true;
                uint childOwner;
                GetWindowThreadProcessId(child, out childOwner);
                if (childOwner != 0 && childOwner != owner) children.Add(childOwner);
            } catch { failed = true; }
            return true;
        };
        EnumChildWindows(hwnd, callback, IntPtr.Zero);
        if (!failed && children.Count == 1) {
            foreach (uint child in children)
                if (String.Equals(ReadProcessName(child), "CalculatorApp.exe", StringComparison.OrdinalIgnoreCase)) return child;
        }
        return owner;
    }

    public static bool IsTargetForeground(IntPtr hwnd) {
        if (!IsWindowEnabled(hwnd)) return false;
        IntPtr foreground = GetForegroundWindow();
        if (foreground == hwnd) return true;
        if (foreground == IntPtr.Zero || GetAncestor(foreground, 2) != hwnd || !IsChild(hwnd, foreground)) return false;
        uint owner, focusedOwner;
        GetWindowThreadProcessId(hwnd, out owner);
        GetWindowThreadProcessId(foreground, out focusedOwner);
        return owner != 0 && owner == focusedOwner;
    }

    // Briefly share input queues for the approved HWND, then detach before injecting input.
    // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-attachthreadinput
    public static bool ActivateWindow(IntPtr hwnd) {
        if (!IsWindow(hwnd)) return false;
        if (IsIconic(hwnd)) ShowWindowAsync(hwnd, 9); // SW_RESTORE
        if (IsTargetForeground(hwnd) && !IsIconic(hwnd)) return true;
        uint caller = GetCurrentThreadId();
        uint ignored;
        uint targetThread = GetWindowThreadProcessId(hwnd, out ignored);
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
        bool foregroundAttached = false, targetAttached = false, detached = true, activated = false;
        try {
            if (foregroundThread != 0 && foregroundThread != caller)
                foregroundAttached = AttachThreadInput(caller, foregroundThread, true);
            if (targetThread != 0 && targetThread != caller && targetThread != foregroundThread)
                targetAttached = AttachThreadInput(caller, targetThread, true);
            SetForegroundWindow(hwnd);
            BringWindowToTop(hwnd);
            for (int attempt = 0; attempt < 25; attempt++) {
                if (IsTargetForeground(hwnd) && !IsIconic(hwnd)) { activated = true; break; }
                System.Threading.Thread.Sleep(20);
            }
        } finally {
            if (targetAttached) detached = AttachThreadInput(caller, targetThread, false) && detached;
            if (foregroundAttached) detached = AttachThreadInput(caller, foregroundThread, false) && detached;
        }
        return activated && detached;
    }
}
'@ | Out-Null

# PrintWindow renders physical pixels. Use the same coordinate space for window
# rectangles and cursor placement on monitors with scaling (PER_MONITOR_AWARE_V2).
if ([PcWinApi]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { exit 1 }

function Test-UnlockedDesktop {
    $desktop = [PcWinApi]::OpenInputDesktop(0, $false, 0x0100)
    if ($desktop -eq [IntPtr]::Zero) { return $false }
    try {
        $buffer = New-Object System.Text.StringBuilder 256
        $required = 0
        if (-not [PcWinApi]::GetUserObjectInformation($desktop, 2, $buffer, 512, [ref]$required)) { return $false }
        return ($buffer.ToString() -eq 'Default')
    } finally { [void][PcWinApi]::CloseDesktop($desktop) }
}

function Request-UiaWindowFocus {
    param([IntPtr]$handle)
    # Request focus through the approved target's accessibility provider. This
    # does not attach to a protected foreground app or relax Windows policy.
    try {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        if ($null -eq $element -or [int64]$element.Current.NativeWindowHandle -ne $handle.ToInt64()) { return $false }
        $focusTarget = $element
        if (-not $element.Current.IsKeyboardFocusable) {
            # Modern Notepad exposes a non-focusable frame and a focusable
            # document. Stay inside this HWND's tree; never select another app.
            $document = [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Document)
            $focusable = [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty, $true)
            $condition = [System.Windows.Automation.AndCondition]::new($document, $focusable)
            $focusTarget = $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
            if ($null -eq $focusTarget) { return $false }
        }
        $focusTarget.SetFocus()
        for ($attempt = 0; $attempt -lt 25; $attempt++) {
            if ([PcWinApi]::IsTargetForeground($handle)) { return $true }
            Start-Sleep -Milliseconds 20
        }
    } catch { }
    return $false
}

function Get-Windows {
    $found = New-Object System.Collections.ArrayList
    $callback = [PcWinApi+EnumWindowsProc]{
        param([IntPtr]$hwnd, [IntPtr]$param)
        if (-not [PcWinApi]::IsWindowVisible($hwnd)) { return $true }
        $title = New-Object System.Text.StringBuilder 513
        if ([PcWinApi]::GetWindowText($hwnd, $title, 513) -le 0) { return $true }
        try {
            $windowProcessId = [PcWinApi]::ResolveWindowProcessId($hwnd)
            [void]$found.Add(@{
                id = $hwnd.ToInt64().ToString()
                title = $title.ToString()
                processName = [PcWinApi]::ReadProcessName($windowProcessId)
            })
        } catch { }
        return ($found.Count -lt 300)
    }
    [void][PcWinApi]::EnumWindows($callback, [IntPtr]::Zero)
    return @($found.ToArray())
}

try {
    if ($PayloadBase64.Length -gt 16384) { throw 'payload too large' }
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
    if ($payload.action -eq 'session') {
        @{ unlocked = (Test-UnlockedDesktop) } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }
    if (-not (Test-UnlockedDesktop)) { throw 'session locked or unavailable' }
    if ($payload.action -eq 'list') {
        ConvertTo-Json -InputObject @(Get-Windows) -Compress -Depth 5
        exit 0
    }

    $idText = [string]$payload.args.windowId
    if ($idText -notmatch '^[1-9][0-9]{0,15}$') { throw 'invalid window' }
    $handle = [IntPtr]([int64]::Parse($idText))
    if (-not [PcWinApi]::IsWindow($handle)) { throw 'window unavailable' }
    [uint32]$targetPid = 0
    [void][PcWinApi]::GetWindowThreadProcessId($handle, [ref]$targetPid)
    $targetAppPid = [PcWinApi]::ResolveWindowProcessId($handle)
    if ([PcWinApi]::ReadProcessName($targetAppPid) -ine [string]$payload.args.processName) { throw 'window owner changed' }
    function Assert-WindowIdentity {
        [uint32]$currentOwner = 0
        [void][PcWinApi]::GetWindowThreadProcessId($handle, [ref]$currentOwner)
        if ($currentOwner -ne $targetPid -or [PcWinApi]::ResolveWindowProcessId($handle) -ne $targetAppPid) { throw 'window owner changed' }
    }
    $currentTitle = New-Object System.Text.StringBuilder 513
    [void][PcWinApi]::GetWindowText($handle, $currentTitle, 513)
    if ($currentTitle.ToString() -cne [string]$payload.args.title) { throw 'window changed' }
    $rect = New-Object PcWinApi+RECT
    if (-not [PcWinApi]::GetWindowRect($handle, [ref]$rect)) { throw 'window rect unavailable' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0 -or $width -gt 8192 -or $height -gt 8192) { throw 'window dimensions unavailable' }

    if ($payload.action -eq 'capture') {
        Add-Type -AssemblyName System.Drawing
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $stream = New-Object System.IO.MemoryStream
        try {
            # Capture only this HWND; never image another application overlaid above it.
            $dc = $graphics.GetHdc()
            try {
                Assert-WindowIdentity
                if (-not [PcWinApi]::PrintWindow($handle, $dc, 2)) { throw 'window capture unavailable' }
            } finally { $graphics.ReleaseHdc($dc) }
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            if ($stream.Length -gt (6 * 1024 * 1024)) { throw 'image too large' }
            @{ mimeType = 'image/png'; base64 = [Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress
        } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
        exit 0
    }

    if (-not [PcWinApi]::IsWindowEnabled($handle)) { throw 'cannot activate window' }
    if (-not [PcWinApi]::ActivateWindow($handle)) {
        Assert-WindowIdentity
        if (-not (Request-UiaWindowFocus $handle)) { throw 'cannot activate window' }
    }
    Start-Sleep -Milliseconds 80
    if (-not [PcWinApi]::IsTargetForeground($handle)) { throw 'window not active' }
    [uint32]$activeOwner = 0
    [void][PcWinApi]::GetWindowThreadProcessId($handle, [ref]$activeOwner)
    if ($activeOwner -ne $targetPid) { throw 'window owner changed' }
    Assert-WindowIdentity
    # Restoring a minimized window changes its rectangle; never reuse the minimized bounds.
    if (-not [PcWinApi]::GetWindowRect($handle, [ref]$rect)) { throw 'window rect unavailable' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0 -or $width -gt 8192 -or $height -gt 8192) { throw 'window dimensions unavailable' }
    Add-Type -AssemblyName System.Windows.Forms
    switch ($payload.action) {
        { $_ -eq 'click' -or $_ -eq 'right_click' -or $_ -eq 'scroll' } {
            $x = [int]$payload.args.x
            $y = [int]$payload.args.y
            if ($x -lt 0 -or $y -lt 0 -or $x -ge $width -or $y -ge $height) { throw 'invalid coordinates' }
            if (-not [PcWinApi]::SetCursorPos($rect.Left + $x, $rect.Top + $y)) { throw 'mouse move failed' }
            if (-not [PcWinApi]::IsTargetForeground($handle)) { throw 'window not active' }
            Assert-WindowIdentity
            if ($payload.action -eq 'scroll') {
                $delta = [int]$payload.args.delta
                if ($delta -eq 0 -or [Math]::Abs($delta) -gt 1080) { throw 'invalid scroll' }
                $unsignedDelta = [BitConverter]::ToUInt32([BitConverter]::GetBytes($delta), 0)
                [PcWinApi]::mouse_event(0x0800, 0, 0, $unsignedDelta, [UIntPtr]::Zero)
            } elseif ($payload.action -eq 'right_click') {
                [PcWinApi]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
                [PcWinApi]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
            } else {
                [PcWinApi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
                [PcWinApi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
            }
        }
        'key' {
            $map = @{
                ENTER='{ENTER}'; ESC='{ESC}'; TAB='{TAB}'; SPACE=' '; BACKSPACE='{BACKSPACE}'
                DELETE='{DELETE}'; UP='{UP}'; DOWN='{DOWN}'; LEFT='{LEFT}'; RIGHT='{RIGHT}'
                HOME='{HOME}'; END='{END}'; PAGEUP='{PGUP}'; PAGEDOWN='{PGDN}'
                F1='{F1}'; F2='{F2}'; F3='{F3}'; F4='{F4}'; F5='{F5}'; F6='{F6}'
                F7='{F7}'; F8='{F8}'; F9='{F9}'; F10='{F10}'; F11='{F11}'; F12='{F12}'
                'CTRL+A'='^a'; 'CTRL+C'='^c'; 'CTRL+F'='^f'; 'CTRL+L'='^l'
                'CTRL+N'='^n'; 'CTRL+P'='^p'; 'CTRL+S'='^s'; 'CTRL+T'='^t'
                'CTRL+V'='^v'; 'CTRL+W'='^w'; 'CTRL+X'='^x'; 'CTRL+Y'='^y'
                'CTRL+Z'='^z'; 'CTRL+SHIFT+P'='^+p'; 'ALT+LEFT'='%{LEFT}'; 'ALT+RIGHT'='%{RIGHT}'
            }
            $keyName = [string]$payload.args.key
            if (-not $map.ContainsKey($keyName)) { throw 'invalid key' }
            if (-not [PcWinApi]::IsTargetForeground($handle)) { throw 'window not active' }
            Assert-WindowIdentity
            [System.Windows.Forms.SendKeys]::SendWait($map[$keyName])
        }
        'type' {
            $message = [string]$payload.args.text
            if ($message.Length -gt 300 -or $message -notmatch '^[\p{L}\p{N} .,_@:/!?()\-]+$') { throw 'invalid text' }
            foreach ($character in $message.ToCharArray()) {
                if (-not [PcWinApi]::IsTargetForeground($handle)) { throw 'window not active' }
                Assert-WindowIdentity
                $literal = [string]$character
                if ($literal -match '[+^%~(){}\[\]]') { $literal = '{' + $literal + '}' }
                [System.Windows.Forms.SendKeys]::SendWait($literal)
            }
        }
        default { throw 'unsupported action' }
    }
    @{ ok = $true } | ConvertTo-Json -Compress
} catch {
    # Never write arguments or the untrusted exception to stdout/stderr.
    if ([string]$_.Exception.Message -in @('cannot activate window', 'window not active')) {
        @{ ok = $false; reason = 'focus_required' } | ConvertTo-Json -Compress
    }
    exit 1
}
