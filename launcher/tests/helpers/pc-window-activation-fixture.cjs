const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = function activationFixture({ denied = false, minimized = false, action = 'key', steal = false, uia = false, foregroundChild = false, disabled = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feno-focus-native-'));
  const scriptPath = path.join(directory, 'helper.ps1');
  const auditPath = path.join(directory, 'audit.json');
  let script = fs.readFileSync(path.join(__dirname, '../../electron/pc-windows-helper.ps1'), 'utf8');
  // Keep the production activation algorithm; isolate USER32 at its native boundary.
  const fields = `
    public static IntPtr Foreground = new IntPtr(202);
    public static bool Denied = ${denied ? 'true' : 'false'};
    public static bool Minimized = ${minimized ? 'true' : 'false'};
    public static bool Steal = ${steal ? 'true' : 'false'};
    public static bool Disabled = ${disabled ? 'true' : 'false'};
    public static int Writes, CursorX, CursorY;
    public static bool PhysicalCoordinates;
    public static System.Collections.Generic.HashSet<uint> Attached = new System.Collections.Generic.HashSet<uint>();
    public static void RecordInput() {
        if ((Foreground != new IntPtr(101) && Foreground != new IntPtr(303)) || Minimized || Attached.Count != 0)
            throw new InvalidOperationException("input without isolated foreground ownership");
        Writes++;
        if (Steal) Foreground = new IntPtr(202);
    }
`;
  script = script.replace('public static class PcWinApi {', 'public static class PcWinApi {' + fields);
  const native = {
    IsWindow: 'public static bool IsWindow(IntPtr hwnd) { return hwnd == new IntPtr(101) || hwnd == new IntPtr(202); }',
    IsWindowEnabled:'public static bool IsWindowEnabled(IntPtr hwnd) { return !Disabled; }',
    GetWindowText: 'public static int GetWindowText(IntPtr hwnd, StringBuilder text, int max) { text.Append("Probe"); return 5; }',
    GetWindowThreadProcessId: 'public static uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid) { pid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id + (hwnd.ToInt32()==304 ? 1u : 0u); return hwnd == new IntPtr(101) ? 200u : 300u; }',
    GetAncestor:'public static IntPtr GetAncestor(IntPtr hwnd, uint flags) { return hwnd.ToInt32()==303 || hwnd.ToInt32()==304 ? new IntPtr(101) : hwnd; }',
    IsChild:'public static bool IsChild(IntPtr parent, IntPtr child) { return parent.ToInt32()==101 && (child.ToInt32()==303 || child.ToInt32()==304); }',
    SetThreadDpiAwarenessContext:'public static IntPtr SetThreadDpiAwarenessContext(IntPtr context) { PhysicalCoordinates=context.ToInt64()==-4; return new IntPtr(1); }',
    GetWindowRect: 'public static bool GetWindowRect(IntPtr hwnd, out RECT rect) { if(!PhysicalCoordinates) throw new InvalidOperationException("DPI-virtualized geometry"); rect = new RECT { Left=100,Top=100,Right=Minimized?260:500,Bottom=Minimized?128:400 }; return true; }',
    GetForegroundWindow: 'public static IntPtr GetForegroundWindow() { return Foreground; }',
    SetForegroundWindow: 'public static bool SetForegroundWindow(IntPtr hwnd) { if (Denied || Minimized || !Attached.Contains(200) || !Attached.Contains(300)) return false; Foreground=hwnd; return true; }',
    BringWindowToTop: 'public static bool BringWindowToTop(IntPtr hwnd) { return SetForegroundWindow(hwnd); }',
    GetCurrentThreadId: 'public static uint GetCurrentThreadId() { return 100; }',
    AttachThreadInput: 'public static bool AttachThreadInput(uint from, uint to, bool attach) { if (from!=100 || from==to) throw new InvalidOperationException("wrong caller thread"); if(attach) Attached.Add(to); else Attached.Remove(to); return true; }',
    IsIconic: 'public static bool IsIconic(IntPtr hwnd) { return Minimized; }',
    ShowWindowAsync: 'public static bool ShowWindowAsync(IntPtr hwnd, int command) { Minimized=false; return true; }',
    SetCursorPos: 'public static bool SetCursorPos(int x, int y) { CursorX=x;CursorY=y;return true; }',
    mouse_event: 'public static void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extraInfo) { if(flags==2) RecordInput(); }',
  };
  for (const [name, body] of Object.entries(native)) {
    const pattern = new RegExp('\\[DllImport\\([^\\]]+\\)\\]\\s*public static extern [^;]+\\b' + name + '\\([^;]*\\);');
    if (pattern.test(script)) script = script.replace(pattern, body);
    else script = script.replace('public static class PcWinApi {', 'public static class PcWinApi {\n' + body);
  }
  const boundary = /\r?\ntry \{\r?\n    if \(\$PayloadBase64/;
  const focused = foregroundChild === 'other-process' ? '[IntPtr]304' : foregroundChild ? '[IntPtr]303' : '$handle';
  const fallback = `\nfunction Request-UiaWindowFocus { param([IntPtr]$handle) ${uia ? `[PcWinApi]::Foreground=${focused}; return $true` : 'return $false'} }\n`;
  script = script.replace(boundary, '\nfunction Test-UnlockedDesktop { return $true }'+fallback+'\ntry {\n    if ($PayloadBase64');
  script = script.replace('[System.Windows.Forms.SendKeys]::SendWait($map[$keyName])', '[PcWinApi]::RecordInput()');
  script = script.replace('[System.Windows.Forms.SendKeys]::SendWait($literal)', '[PcWinApi]::RecordInput()');
  const sourceStart = script.indexOf('# Fixed, packaged helper:');
  const audit = `[IO.File]::WriteAllText('${auditPath.replaceAll("'", "''")}', (@{ writes=[PcWinApi]::Writes; attached=[PcWinApi]::Attached.Count; foreground=[PcWinApi]::Foreground.ToInt64(); x=[PcWinApi]::CursorX; y=[PcWinApi]::CursorY } | ConvertTo-Json -Compress))`;
  script = script.slice(0, sourceStart) + 'try {\n' + script.slice(sourceStart) + '\n} finally { ' + audit + ' }\n';
  fs.writeFileSync(scriptPath, '\uFEFF' + script);
  try {
    const args = { windowId:'101',processName:'powershell.exe',title:'Probe',key:'ESC',text:'AB',x:200,y:180 };
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptPath,'-PayloadBase64',Buffer.from(JSON.stringify({action,args})).toString('base64')],
      {windowsHide:true,encoding:'utf8',timeout:12000});
    return { status:result.status,stdout:result.stdout,stderr:result.stderr,
      audit:fs.existsSync(auditPath)?JSON.parse(fs.readFileSync(auditPath,'utf8')):null };
  } finally {
    if(fs.existsSync(auditPath))fs.unlinkSync(auditPath);
    fs.unlinkSync(scriptPath);fs.rmdirSync(directory);
  }
};
