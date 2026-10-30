param(
    [Parameter(Mandatory=$true)][string]$PayloadBase64
)

# Fixed, packaged helper: model input is JSON data, never PowerShell source.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PcWinApi {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr param);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder buffer, int length, out int needed);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
}
'@ | Out-Null

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

function Get-Windows {
    $found = New-Object System.Collections.ArrayList
    $callback = [PcWinApi+EnumWindowsProc]{
        param([IntPtr]$hwnd, [IntPtr]$param)
        if (-not [PcWinApi]::IsWindowVisible($hwnd)) { return $true }
        $title = New-Object System.Text.StringBuilder 513
        if ([PcWinApi]::GetWindowText($hwnd, $title, 513) -le 0) { return $true }
        [uint32]$pid = 0
        [void][PcWinApi]::GetWindowThreadProcessId($hwnd, [ref]$pid)
        try {
            $process = [System.Diagnostics.Process]::GetProcessById([int]$pid)
            [void]$found.Add(@{
                id = $hwnd.ToInt64().ToString()
                title = $title.ToString()
                processName = ($process.ProcessName + '.exe')
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
    $targetProcess = [System.Diagnostics.Process]::GetProcessById([int]$targetPid)
    if (($targetProcess.ProcessName + '.exe') -ine [string]$payload.args.processName) { throw 'window owner changed' }
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
                if (-not [PcWinApi]::PrintWindow($handle, $dc, 2)) { throw 'window capture unavailable' }
            } finally { $graphics.ReleaseHdc($dc) }
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            if ($stream.Length -gt (6 * 1024 * 1024)) { throw 'image too large' }
            @{ mimeType = 'image/png'; base64 = [Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress
        } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
        exit 0
    }

    if (-not [PcWinApi]::SetForegroundWindow($handle)) { throw 'cannot activate window' }
    Start-Sleep -Milliseconds 80
    if ([PcWinApi]::GetForegroundWindow() -ne $handle) { throw 'window not active' }
    Add-Type -AssemblyName System.Windows.Forms
    switch ($payload.action) {
        'click' {
            $x = [int]$payload.args.x
            $y = [int]$payload.args.y
            if ($x -lt 0 -or $y -lt 0 -or $x -ge $width -or $y -ge $height) { throw 'invalid coordinates' }
            if (-not [PcWinApi]::SetCursorPos($rect.Left + $x, $rect.Top + $y)) { throw 'mouse move failed' }
            [PcWinApi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            [PcWinApi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        }
        'key' {
            $map = @{
                ENTER='{ENTER}'; ESC='{ESC}'; TAB='{TAB}'; SPACE=' '; BACKSPACE='{BACKSPACE}'
                DELETE='{DELETE}'; UP='{UP}'; DOWN='{DOWN}'; LEFT='{LEFT}'; RIGHT='{RIGHT}'
                HOME='{HOME}'; END='{END}'; PAGEUP='{PGUP}'; PAGEDOWN='{PGDN}'
            }
            $keyName = [string]$payload.args.key
            if (-not $map.ContainsKey($keyName)) { throw 'invalid key' }
            [System.Windows.Forms.SendKeys]::SendWait($map[$keyName])
        }
        'type' {
            $message = [string]$payload.args.text
            if ($message.Length -gt 300 -or $message -notmatch '^[\p{L}\p{N} .,_@:/!?()\-]+$') { throw 'invalid text' }
            foreach ($character in $message.ToCharArray()) {
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
    exit 1
}
