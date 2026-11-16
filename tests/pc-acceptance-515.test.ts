import {expect,test} from 'bun:test';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {normalizePcDesktopKey,createPcWindowsController} from '../src/pc-control/windows';
import {createPcApplicationLauncher} from '../src/pc-control/launch';
import {pcResourceLockFile} from '../src/pc-control/resource-locks';
import {containedWindowsTerminalSpec} from '../src/pc-control/terminal-containment';
import {createPcFile,readPcFile,listPcFiles} from '../src/pc-control/files';

function full(root:string){
  const a=new PcAuthorizer({profileId:'pc2-normal'});
  a.setGrantFromLocalApproval({profileId:'pc2-normal',id:'acceptance-515-grant',expiresAt:null,fullAccess:true,
    roots:['C:\\','D:\\','G:\\'],allowedApps:[],permissions:['files.read','files.write','jobs','terminal.exec','screen.read','desktop.input','adb','runner','desktop.advanced','apps.launch','screen.full']});
  return a;
}
const win=process.platform==='win32'?test:test.skip;

test('T23/24/28-31/39: every documented shortcut is normalized',()=>{
  for(const [raw,vk] of [['Esc','ESC'],['Ctrl+L','CTRL+L'],['CTRL+T','CTRL+T'],['Ctrl+Shift+Tab','CTRL+SHIFT+TAB'],
    ['Alt+F4','ALT+F4'],['Enter','ENTER'],['Tab','TAB'],['Ctrl+End','CTRL+END'],
    ...'ACVW123456789'.split('').map(ch=>[`Ctrl+${ch}`,`CTRL+${ch}`])])
    expect(normalizePcDesktopKey(raw)).toBe(vk);
});

win('helper contract: C# key names resolve to actual virtual-key sequences without injecting input',()=>{
  const exe=join(import.meta.dir,'..','.cache','pc-windows-helper.exe');
  for(const [key,keys] of [['Esc',[27]],['CTRL+L',[17,76]],['Ctrl+Shift+Tab',[17,16,9]],
    ['Alt+F4',[18,115]],['Ctrl+9',[17,57]],['Ctrl+End',[17,35]] ] as const){
    const payload=Buffer.from(JSON.stringify({action:'keymap',args:{key}})).toString('base64');
    const result=spawnSync(exe,['--payload',payload],{encoding:'utf8',windowsHide:true});
    expect(result.status).toBe(0);expect(JSON.parse(result.stdout).keys).toEqual(keys);
  }
});

test('T25/26/28/29/34: terminal, desktop and ADB use independent lock namespaces',()=>{
  expect(pcResourceLockFile('terminal')).not.toBe(pcResourceLockFile('desktop-input'));
  expect(pcResourceLockFile('terminal')).not.toBe(pcResourceLockFile('adb'));
  expect(pcResourceLockFile('job')).toBe(pcResourceLockFile('terminal'));
});

test('T39: launch browser URL with isolated approved test profile',async()=>{
  const auth=full('D:\\');const calls:string[][]=[];
  const launch=createPcApplicationLauncher({authorizer:auth,resolve:()=> 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',spawnApp:(_exe,args)=>{calls.push(args);}});
  expect(await launch.launchPcApp('chrome.exe','https://example.com/',undefined,'D:\\PC2-Browser-Test-Profile')).toMatchObject({launched:true});
  expect(calls[0]).toEqual(['--user-data-dir=D:\\PC2-Browser-Test-Profile','https://example.com/']);
  await expect(launch.launchPcApp('notepad.exe',undefined,undefined,'D:\\PC2-Browser-Test-Profile')).rejects.toThrow('pc_invalid_argument');
});

test('T26: full-access native input forwards frame permission, selected access does not',async()=>{
  const helperCalls:Record<string,unknown>[]=[];
  const helper=async(action:string,args:Record<string,unknown>)=>{
    if(action==='session')return {unlocked:true};if(action==='list')return [{id:'123',title:'Notepad',processName:'notepad.exe'}];
    helperCalls.push(args);return {ok:true};
  };
  await createPcWindowsController({authorizer:full('D:\\'),runHelper:helper}).pcDesktopInput({windowId:'123',action:'click',x:30,y:10});
  expect(helperCalls[0]).toMatchObject({allowNonClient:true});
});

test('T31: full-access clipboard is bounded and delegated to helper, without window dependency',async()=>{
  const calls:string[]=[];
  const controller=createPcWindowsController({authorizer:full('D:\\'),runHelper:async(action,args)=>{
    calls.push(action);if(action==='session')return {unlocked:true};if(action==='clipboard_read')return {text:'ş ğ ı ö ü ç'};
    return {ok:true};
  }});
  expect(await controller.clipboardRead()).toEqual({text:'ş ğ ı ö ü ç'});
  expect(await controller.clipboardWrite('Türkçe ş ğ ı ö ü ç')).toEqual({ok:true});
  expect(calls).toContain('clipboard_write');
  await expect(controller.clipboardWrite('a'.repeat(65537))).rejects.toThrow('pc_invalid_argument');
});

test('T09: PowerShell terminal emits UTF-8 for native subprocess stdout',()=>{
  expect(containedWindowsTerminalSpec('Write-Output kaydı').args.join(' ')).toContain('OutputEncoding');
});
test('T25: only single GUI launches request safe breakaway from contained terminal',()=>{
  expect(containedWindowsTerminalSpec('notepad.exe D:\\temp\\note.txt').allowGuiBreakaway).toBe(true);
  expect(containedWindowsTerminalSpec('cmd /c start "" chrome.exe https://example.com/').allowGuiBreakaway).toBe(true);
  for(const unsafe of ['notepad.exe a.txt; Start-Sleep 30','cmd /c start "" powershell.exe','Get-ChildItem','notepad.exe a.txt | Out-File result.txt'])
    expect(containedWindowsTerminalSpec(unsafe).allowGuiBreakaway).toBe(false);
});

win('T39: full-access Notepad filePath is accepted by launcher runtime',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-acceptance-notepad-'));
  const file=join(root,'note.txt');writeFileSync(file,'data');const calls:string[][]=[];
  const launch=createPcApplicationLauncher({authorizer:full(root),resolve:()=> 'C:\\Windows\\System32\\notepad.exe',spawnApp:(_exe,args)=>{calls.push(args);}});
  expect(await launch.launchPcApp('notepad.exe',undefined,file)).toMatchObject({launched:true});
  expect(calls[0]).toEqual([file]);
});

win('T10/T36: existing file and sensitive path expose distinct non-leaking codes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-acceptance-515-'));
  const auth=full(root),p=join(root,'existing.txt');writeFileSync(p,'existing');
  await expect(createPcFile(p,'new',auth)).rejects.toMatchObject({code:'pc_file_exists'});
  await expect(readPcFile(join(root,'.env'),auth)).rejects.toMatchObject({code:'pc_sensitive_path'});
  const entries=await listPcFiles(root,'',auth);
  expect(entries).toMatchObject({omitted:{sensitive:true,junctions:true}});
  expect(readFileSync(p,'utf8')).toBe('existing');
});
