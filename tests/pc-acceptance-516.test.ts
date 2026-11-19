import {afterAll,expect,test} from 'bun:test';
import {mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
import { trackTempDirectories } from './support/temp-directories';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {createPcWindowsController} from '../src/pc-control/windows';
import {createPcApplicationLauncher,validatePcLaunchUrl} from '../src/pc-control/launch';
import {createPcAdbController,type PcAdbRun} from '../src/pc-control/adb';

const mkdtempSync = trackTempDirectories(afterAll);

const windowsOnly=process.platform==='win32'?test:test.skip;
function full(fullAccess=true){
  const a=new PcAuthorizer({profileId:'pc2-normal'});
  a.setGrantFromLocalApproval({profileId:'pc2-normal',id:'acceptance-516',expiresAt:null,fullAccess,
    roots:fullAccess?['C:\\','D:\\']:['C:\\fixture'],allowedApps:[],permissions:['files.read','files.write','jobs','terminal.exec',
      'screen.read','screen.full','desktop.input','desktop.advanced','apps.launch','adb','runner','browser',...(fullAccess?['chrome.user' as const]:[])]});
  return a;
}

test('T23-25: full-access input requests focus recovery for type, click and keyboard including Esc',async()=>{
  const calls:{action:string;args:Record<string,unknown>}[]=[];
  const desktop=createPcWindowsController({authorizer:full(),isInteractive:async()=>true,runHelper:async(action,args)=>{
    if(action==='list')return [{id:'123',title:'Notepad',processName:'notepad.exe'}];
    calls.push({action,args});return {ok:true};
  }});
  await desktop.pcDesktopInput({windowId:'123',action:'type',text:'ŞĞÜÖİ'});
  await desktop.pcDesktopInput({windowId:'123',action:'click',x:10,y:10});
  await desktop.pcDesktopInput({windowId:'123',action:'key',key:'CTRL+S'});
  await desktop.pcDesktopInput({windowId:'123',action:'key',key:'CTRL+END'});
  await desktop.pcDesktopInput({windowId:'123',action:'key',key:'ESC'});
  expect(calls.map(c=>c.action)).toEqual(['type','click','key','key','key']);
  expect(calls.every(c=>c.args.allowFocus===true)).toBe(true);
});

windowsOnly('T23-25: launcher returns and activates the verified Notepad window id',async()=>{
  const actions:string[]=[];
  const launch=createPcApplicationLauncher({authorizer:full(),
    resolve:()=> 'C:\\Windows\\System32\\notepad.exe',spawnApp:()=>{},
    windowHelper:async(action,args)=>{
      actions.push(action);
      if(action==='list')return [{id:'123',title:'Notepad',processName:'notepad.exe'}];
      if(action==='activate'){expect(args).toMatchObject({windowId:'123',processName:'notepad.exe'});return {ok:true};}
      throw Error('unexpected helper action');
    }});
  expect(await launch.launchPcApp('notepad')).toEqual({launched:true,app:'notepad.exe',windowId:'123',focused:true});
  expect(actions).toContain('activate');
});

windowsOnly('T31: canonical allowed file URL opens but escapes, UNC and unsafe URLs fail',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'pc2-t31-'));
  const local=join(folder,'ş ğ ı ö ü ç.html');writeFileSync(local,'<p>ok</p>','utf8');
  const url=pathToFileURL(local).href;
  const calls:string[][]=[];
  const launch=createPcApplicationLauncher({authorizer:full(),
    resolve:()=> 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    spawnApp:(_exe,args)=>{calls.push(args);}});
  expect(validatePcLaunchUrl(url,['C:\\','D:\\'],true)).toBe(url);
  expect(await launch.launchPcApp('chrome.exe',url)).toMatchObject({launched:true});
  expect(calls[0]).toEqual([url]);
  for(const bad of ['file://remote/share/page.html','file:///C:/Windows/../Windows/win.ini',
    'file:///C:/Users/%2e%2e/Windows/win.ini','file:///C:/x%5cy.html',url+'#frag'])
    await expect(launch.launchPcApp('chrome.exe',bad)).rejects.toMatchObject({code:'pc_invalid_argument'});
  const out=mkdtempSync(join(tmpdir(),'pc2-t31-out-'));
  const link=join(folder,'junction');mkdirSync(join(out,'child'));
  try{
    symlinkSync(out,link,'junction');
    const wrapped=join(link,'child','escape.html');writeFileSync(join(out,'child','escape.html'),'ok');
    await expect(launch.launchPcApp('chrome.exe',pathToFileURL(wrapped).href)).rejects.toMatchObject({code:'pc_invalid_argument'});
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='EPERM')throw error;
  }
});

test('T34: valid Android key names and short aliases normalize; unknown keys are argument errors',async()=>{
  const calls:string[][]=[];
  const run:PcAdbRun=async(_executable,args)=>{
    calls.push(args);
    return {exitCode:0,stdout:Buffer.from(args.length===1?'List of devices attached\nemulator-5554\tdevice\n':''),stderr:Buffer.alloc(0)};
  };
  const controller=createPcAdbController({authorizer:full(),adbPath:'C:\\fixture\\adb.exe',runCommand:run});
  for(const key of ['KEYCODE_SETTINGS','HOME','BACK','ENTER','SETTINGS','KEYCODE_F1','KEYCODE_CAPS_LOCK'])
    await controller.adbInput('emulator-5554',{action:'key',value:key});
  expect(calls.filter(args=>args.includes('keyevent')).map(args=>args.at(-1)))
    .toEqual(['KEYCODE_SETTINGS','KEYCODE_HOME','KEYCODE_BACK','KEYCODE_ENTER','KEYCODE_SETTINGS','KEYCODE_F1','KEYCODE_CAPS_LOCK']);
  for(const bad of ['KEYCODE_NOT_REAL','BOGUS','KEYCODE_;DROP'])
    await expect(controller.adbInput('emulator-5554',{action:'key',value:bad})).rejects.toMatchObject({code:'pc_invalid_argument',details:{field:'value'}});
});

test('T34: selective ADB permission keeps the earlier limited key set',async()=>{
  const calls:string[][]=[];
  const run:PcAdbRun=async(_exe,args)=>{
    calls.push(args);
    return {exitCode:0,stdout:Buffer.from(args.length===1?'List of devices attached\nemulator-5554\tdevice\n':''),stderr:Buffer.alloc(0)};
  };
  const controller=createPcAdbController({authorizer:full(false),adbPath:'C:\\fixture\\adb.exe',runCommand:run});
  await controller.adbInput('emulator-5554',{action:'key',value:'HOME'});
  await expect(controller.adbInput('emulator-5554',{action:'key',value:'KEYCODE_POWER'}))
    .rejects.toMatchObject({code:'pc_access_denied'});
  expect(calls.filter(args=>args.includes('keyevent')).map(args=>args.at(-1))).toEqual(['KEYCODE_HOME']);
});

windowsOnly('launcher aliases normalize case and unknown bare names produce argument error',async()=>{
  const called:string[]=[];
  const launch=createPcApplicationLauncher({authorizer:full(),
    resolve:app=>{called.push(app);return 'C:\\Windows\\System32\\notepad.exe';},spawnApp:()=>{}});
  expect(await launch.launchPcApp('NOTEPAD')).toMatchObject({launched:true,app:'notepad.exe'});
  expect(await launch.launchPcApp('Chrome')).toMatchObject({launched:true,app:'chrome.exe'});
  expect(called).toEqual(['notepad.exe','chrome.exe']);
  await expect(launch.launchPcApp('does-not-exist')).rejects.toMatchObject({code:'pc_invalid_argument',details:{field:'app'}});
});

windowsOnly('launcher never substitutes an unrelated existing Chrome window for a requested URL',async()=>{
  const launch=createPcApplicationLauncher({authorizer:full(),
    resolve:()=> 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',spawnApp:()=>{},
    windowHelper:async(action)=>action==='list'
      ?[{id:'987',title:'Existing browser tab',processName:'chrome.exe'}]:{ok:true}});
  expect(await launch.launchPcApp('chrome','https://example.com/'))
    .toMatchObject({launched:true,focused:false});
});
