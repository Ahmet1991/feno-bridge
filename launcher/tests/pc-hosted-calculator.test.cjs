const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

test('hosted Calculator identity stays limited to the selected frame and its single CoreWindow process', {skip:process.platform !== 'win32'}, () => {
  const source = fs.readFileSync(path.join(__dirname,'../electron/pc-windows-helper.ps1'),'utf8');
  let native = source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  const replacements = {
    GetWindowThreadProcessId:'public static uint GetWindowThreadProcessId(IntPtr h, out uint p) { p = h.ToInt32()==10 ? 1u : h.ToInt32()==20 ? 2u : 3u; return 1; }',
    GetClassName:'public static int GetClassName(IntPtr h, StringBuilder s, int n) { s.Append(CoreClass); return CoreClass.Length; }',
    EnumChildWindows:'public static bool EnumChildWindows(IntPtr h, EnumWindowsProc cb, IntPtr p) { if(h.ToInt32()==10) foreach(int child in Children) cb(new IntPtr(child),p); return true; }',
  };
  for(const [name,body] of Object.entries(replacements)) native=native.replace(new RegExp('\\[DllImport\\([^\\]]+\\)\\]\\s*public static extern [^;]+\\b'+name+'\\([^;]*\\);'),body);
  native=native.replace(/public static string ReadProcessName\(uint processId\) \{[\s\S]*?\n    \}/,'public static string ReadProcessName(uint processId) { return processId==1 ? OwnerName : processId==2 ? ChildName : "Other.exe"; }');
  native=native.replace('public static class PcWinApi {',`public static class PcWinApi {
    public static string OwnerName="ApplicationFrameHost.exe", ChildName="CalculatorApp.exe", CoreClass="Windows.UI.Core.CoreWindow";
    public static int[] Children=new int[]{20};`);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feno-calculator-owner-'));
  const script=path.join(directory,'identity.ps1');
  fs.writeFileSync(script,`Add-Type -TypeDefinition @'\n${native}\n'@\n
$results = New-Object System.Collections.ArrayList
[void]$results.Add([PcWinApi]::ResolveWindowProcessId([IntPtr]10))
[PcWinApi]::ChildName='Other.exe'
[void]$results.Add([PcWinApi]::ResolveWindowProcessId([IntPtr]10))
[PcWinApi]::ChildName='CalculatorApp.exe'; [PcWinApi]::Children=@()
[void]$results.Add([PcWinApi]::ResolveWindowProcessId([IntPtr]10))
[PcWinApi]::Children=@(20,30)
[void]$results.Add([PcWinApi]::ResolveWindowProcessId([IntPtr]10))
[PcWinApi]::Children=@(20); [PcWinApi]::CoreClass='OtherClass'
[void]$results.Add([PcWinApi]::ResolveWindowProcessId([IntPtr]10))
[PcWinApi]::OwnerName='notepad.exe'
[void]$results.Add([PcWinApi]::ResolveWindowProcessId([IntPtr]10))
ConvertTo-Json -InputObject @($results.ToArray()) -Compress
`);
  try {
    const r=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',script],{encoding:'utf8',windowsHide:true,timeout:12000});
    assert.equal(r.status,0,r.stderr);
    assert.deepEqual(JSON.parse(r.stdout),[2,1,1,1,1,1]);
  } finally { fs.unlinkSync(script); fs.rmdirSync(directory); }
});
