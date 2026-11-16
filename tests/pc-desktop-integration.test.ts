import {test,expect} from 'bun:test';
import {PcAuthorizer,PcAccessDeniedError} from '../src/pc-control/authorization';
import {PcOperationError} from '../src/pc-control/errors';
import {createPcWindowsController,type PcWindowsHelper} from '../src/pc-control/windows';
import {createPcAdbController,type PcAdbRun} from '../src/pc-control/adb';
import {createPcApplicationLauncher,validatePcLaunchUrl} from '../src/pc-control/launch';
import {createLocalPcHost} from '../src/pc-control/mcp-tools';
import {getRunnerStatus} from '../src/pc-control/runner';
import type {PcGrant,PcPermission} from '../src/pc-control/types';

const PNG=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const windowInfo={id:'123',title:'Fixture - Not Defteri',processName:'notepad.exe'};
function approve(permissions:PcPermission[],allowedApps=['notepad.exe'],profile:'pc2-normal'|'pc2-dev'='pc2-normal'){
  const authorizer=new PcAuthorizer({profileId:profile,clock:()=>1000});
  const grant:PcGrant={profileId:profile,id:'fixture-desktop-0001',expiresAt:60000,roots:['D:\\GitHub\\fixture'],permissions,allowedApps};
  authorizer.setGrantFromLocalApproval(grant);
  return authorizer;
}
function fixtureHelper(result:{focus?:boolean;onCall?:(action:string)=>void}={}):PcWindowsHelper {
  return async action=>{
    result.onCall?.(action);
    if(action==='session')return {unlocked:true};
    if(action==='list')return [windowInfo,{id:'234',title:'Private',processName:'secret.exe'}];
    if(action==='capture'||action==='full')return {mimeType:'image/png',base64:PNG.toString('base64')};
    return result.focus===false?{ok:false,reason:'focus_required'}:{ok:true};
  };
}
const windows=(a:PcAuthorizer,helper=fixtureHelper())=>createPcWindowsController({authorizer:a,runHelper:helper});

test('each Windows operation fails closed without current permission and profile',async()=>{
  const a=new PcAuthorizer({profileId:'pc2-normal',clock:()=>1000});const w=windows(a);
  expect(w.listPcWindows()).rejects.toThrow('pc_access_denied');
  expect(w.capturePcWindow('123')).rejects.toThrow('pc_access_denied');
  expect(w.captureFull('all')).rejects.toThrow('pc_access_denied');
  expect(w.pcDesktopInput({windowId:'123',action:'key',key:'ENTER'})).rejects.toThrow('pc_access_denied');
  expect(()=>a.setGrantFromLocalApproval({profileId:'pc2-dev',id:'wrong-profile-0001',expiresAt:60000,roots:[],permissions:['screen.read'],allowedApps:['notepad.exe']})).toThrow();
});

test('approved window list filters allowedApps and capture only returns bounded PNG',async()=>{
  const a=approve(['screen.read']);const w=windows(a);
  expect(await w.listPcWindows()).toEqual([windowInfo]);
  expect((await w.capturePcWindow('123')).data).toEqual(PNG);
  expect(w.capturePcWindow('234')).rejects.toThrow('pc_access_denied');
  expect(w.captureFull('all')).rejects.toThrow('pc_access_denied');
  expect(w.capturePcWindow('123a')).rejects.toThrow('pc_access_denied');
  const bad=windows(a,async action=>action==='list'?[windowInfo]:action==='session'?{unlocked:true}:{mimeType:'image/png',base64:Buffer.alloc(6*1024*1024+1).toString('base64')});
  expect(bad.capturePcWindow('123')).rejects.toThrow('pc_access_denied');
});

test('full screen opt-in is separate from approved-window permission',async()=>{
  const a=approve(['screen.full'],[]);const w=windows(a);
  expect((await w.captureFull('monitor',0)).data).toEqual(PNG);
  expect(w.listPcWindows()).rejects.toThrow('pc_access_denied');
  expect(w.captureFull('monitor',9)).rejects.toThrow('pc_access_denied');
  expect(w.captureFull('all',0)).rejects.toThrow('pc_access_denied');
});

test('desktop focus loss returns pc_focus_required, while invalid input and unlisted apps are denied',async()=>{
  const a=approve(['desktop.input']);
  const w=windows(a,fixtureHelper({focus:false}));
  try{await w.pcDesktopInput({windowId:'123',action:'click',x:4,y:5});throw Error('unexpected success');}
  catch(e){expect((e as PcOperationError).code).toBe('pc_focus_required');}
  expect(w.pcDesktopInput({windowId:'234',action:'key',key:'ENTER'})).rejects.toThrow('pc_access_denied');
  expect(w.pcDesktopInput({windowId:'123',action:'type',text:'x'.repeat(301)})).rejects.toThrow('pc_invalid_argument');
  expect(w.pcDesktopInput({windowId:'123',action:'key',key:'ALT+TAB'})).rejects.toMatchObject({code:'pc_invalid_argument',details:{field:'key'}});
  expect(w.pcDesktopInput({windowId:'123',action:'click',x:-1,y:0})).rejects.toThrow('pc_invalid_argument');
  expect(w.pcDesktopInput({windowId:'123',action:'drag',x:1,y:1,endX:2,endY:2})).rejects.toThrow('pc_access_denied');
});

test('double click and drag require independent advanced permission and valid endpoint',async()=>{
  const a=approve(['desktop.input','desktop.advanced']);const calls:string[]=[];
  const w=windows(a,fixtureHelper({onCall:action=>calls.push(action)}));
  expect(await w.pcDesktopInput({windowId:'123',action:'double_click',x:1,y:2})).toEqual({ok:true});
  expect(await w.pcDesktopInput({windowId:'123',action:'drag',x:1,y:2,endX:3,endY:4})).toEqual({ok:true});
  expect(calls).toContain('drag');
  expect(w.pcDesktopInput({windowId:'123',action:'drag',x:1,y:2,endX:-1,endY:4})).rejects.toThrow('pc_invalid_argument');
  expect(await w.pcDesktopInput({windowId:'123',action:'key',key:'Escape'})).toEqual({ok:true});
  expect(await w.pcDesktopInput({windowId:'123',action:'key',key:'Ctrl+S'})).toEqual({ok:true});
  expect(await w.pcDesktopInput({windowId:'123',action:'key',key:'Ctrl+End'})).toEqual({ok:true});
});

test('revoking grant or aborting capture during helper execution suppresses image output',async()=>{
  const a=approve(['screen.read']);let finish!:(result:unknown)=>void;
  const helper:PcWindowsHelper=action=>action==='session'?Promise.resolve({unlocked:true}):action==='list'?Promise.resolve([windowInfo]):new Promise(resolve=>{finish=resolve;});
  const pending=windows(a,helper).capturePcWindow('123');
  for(let i=0;!finish&&i<10;i++)await Bun.sleep(1);
  expect(finish).toBeDefined();a.revoke();finish({mimeType:'image/png',base64:PNG.toString('base64')});
  expect(pending).rejects.toThrow('pc_access_denied');
  const b=approve(['screen.read']);const abort=new AbortController();
  const stopped=createPcWindowsController({authorizer:b,runHelper:fixtureHelper(),signal:abort.signal});abort.abort();
  expect(stopped.listPcWindows()).rejects.toThrow('pc_access_denied');
});

test('ADB fake denies physical devices, malformed serials, injection, and changed grants',async()=>{
  const a=approve(['adb'],[]);const invocations:string[][]=[];
  const run:PcAdbRun=async(_exe,args)=>{
    invocations.push(args);
    return {exitCode:0,stdout:args.length===1?Buffer.from('List of devices attached\nemulator-5554\tdevice\n192.168.1.103:5555\tdevice\n'):PNG,stderr:Buffer.alloc(0)};
  };
  const d=createPcAdbController({authorizer:a,adbPath:'C:\\fixture\\adb.exe',runCommand:run});
  expect(await d.adbDevices()).toHaveLength(2);
  expect(d.adbInput('192.168.1.103:5555',{action:'key',value:'KEYCODE_HOME'})).rejects.toThrow('pc_access_denied');
  expect(d.adbScreenshot('192.168.1.103:5555')).rejects.toThrow('pc_access_denied');
  expect(d.adbInput('emulator-5554',{action:'text',value:'unsafe;command'})).rejects.toThrow('pc_access_denied');
  await d.adbInput('emulator-5554',{action:'tap',x:4,y:5});
  expect(invocations.at(-1)).toEqual(['-s','emulator-5554','shell','input','tap','4','5']);
  expect(await d.adbScreenshot('emulator-5554')).toEqual(PNG);
  a.revoke();expect(d.adbDevices()).rejects.toThrow('pc_access_denied');
});

test('ADB running command cannot return after grant changes',async()=>{
  const a=approve(['adb'],[]);let finish!:(value:{exitCode:number;stdout:Buffer;stderr:Buffer})=>void;
  const run:PcAdbRun=async(_exe,args)=>args.length===1?{exitCode:0,stdout:Buffer.from('List of devices attached\nemulator-5554\tdevice\n'),stderr:Buffer.alloc(0)}:
    new Promise(resolve=>{finish=resolve;});
  const d=createPcAdbController({authorizer:a,adbPath:'C:\\fixture\\adb.exe',runCommand:run});
  const pending=d.adbInput('emulator-5554',{action:'key',value:'KEYCODE_ENTER'});
  for(let i=0;!finish&&i<10;i++)await Bun.sleep(1);
  expect(finish).toBeDefined();a.revoke();finish({exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)});
  expect(pending).rejects.toThrow('pc_access_denied');
});

test('launcher uses fixed app IDs, local executable and one validated browser URL',async()=>{
  const a=approve(['apps.launch'],['chrome.exe']);const calls:{executable:string;args:string[]}[]=[];
  const launcher=createPcApplicationLauncher({authorizer:a,resolve:()=> 'C:\\Program Files\\Chrome\\chrome.exe',spawnApp:(executable,args)=>{calls.push({executable,args});}});
  expect(await launcher.launchPcApp('chrome.exe','https://example.com/')).toEqual({launched:true,app:'chrome.exe'});
  expect(calls).toHaveLength(1);expect(calls[0]!.args).toEqual(['https://example.com/']);
  for(const [app,url] of [['cmd.exe',undefined],['notepad.exe',undefined],['chrome.exe','--incognito'],['chrome.exe','file:///C:/secret'],
    ['chrome.exe','https://example.com/ --disable-security'],['chrome.exe','https://user:pass@example.com/'],['chrome.exe','https://example.com\\@evil/']] as const)
    await expect(launcher.launchPcApp(app,url)).rejects.toThrow(app==='chrome.exe'?'pc_invalid_argument':'pc_access_denied');
  expect(calls).toHaveLength(1);
  expect(()=>validatePcLaunchUrl('http://127.0.0.1/path?x=1')).not.toThrow();
  a.revoke();await expect(launcher.launchPcApp('chrome.exe')).rejects.toThrow('pc_access_denied');
});

test('launcher reports success only after spawn succeeds and rechecks revoked permission',async()=>{
  const a=approve(['apps.launch'],['chrome.exe']);
  const launcher=createPcApplicationLauncher({authorizer:a,resolve:()=> 'C:\\Program Files\\Chrome\\chrome.exe',
    spawnApp:async()=>{throw new Error('spawn ENOENT');}});
  await expect(launcher.launchPcApp('chrome.exe')).rejects.toThrow();
  let release!:()=>void;
  const waiting=createPcApplicationLauncher({authorizer:a,resolve:()=> 'C:\\Program Files\\Chrome\\chrome.exe',
    spawnApp:()=>new Promise<void>(resolve=>{release=resolve;})});
  const pending=waiting.launchPcApp('chrome.exe');
  expect(release).toBeDefined();a.revoke();release();
  await expect(pending).rejects.toThrow('pc_access_denied');
});

test('the one-controller lease serializes desktop input and revoke aborts in-flight work',async()=>{
  const a=approve(['desktop.input','screen.read']);let held=false,releaseCount=0,finish!:(value:unknown)=>void;
  const helper:PcWindowsHelper=async(action,_args,signal)=>{
    if(action==='session')return {unlocked:true};if(action==='list')return [windowInfo];
    if(action==='key')return new Promise(resolve=>{
      finish=resolve;
      signal?.addEventListener('abort',()=>resolve({ok:false}),{once:true});
    });
    return {ok:true};
  };
  const host=createLocalPcHost(a,{windowsHelper:helper,auditCommand:()=>{},acquireLease:async operation=>{
    if(held)throw new PcOperationError('pc_resource_busy');
    expect(operation).toBe('desktop-input');held=true;
    return {generation:'fixture',releaseAfterExit:async proof=>{await proof;held=false;releaseCount++;}};
  }});
  const pending=host.desktopInput!({windowId:'123',action:'key',key:'ENTER'});
  for(let i=0;!finish&&i<20;i++)await Bun.sleep(1);
  expect(finish).toBeDefined();
  expect(host.desktopInput!({windowId:'123',action:'key',key:'ENTER'})).rejects.toMatchObject({code:'pc_resource_busy'});
  a.revoke();await host.revokeActiveJobs();finish({ok:true});
  expect(pending).rejects.toThrow('pc_access_denied');
  expect(releaseCount).toBe(1);
});

test('runner is read-only and requires runner permission',async()=>{
  const a=approve(['runner'],[]);let probes=0;
  const probe=async()=>{probes++;return {state:'online' as const,runnerName:'fenotip-tv',busy:false};};
  const host=createLocalPcHost(a,{runnerProbe:probe,auditCommand:()=>{},acquireLease:async()=>{throw new PcAccessDeniedError();}});
  expect(await host.runnerStatus!()).toMatchObject({state:'online',source:'configured-probe'});
  expect(probes).toBe(1);
  expect(await getRunnerStatus({label:'fenotip-tv'})).toMatchObject({state:'unknown'});
  a.revoke();expect(host.runnerStatus!()).rejects.toThrow('pc_access_denied');
});
