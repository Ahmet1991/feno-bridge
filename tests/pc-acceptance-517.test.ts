import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {createPcWindowsController} from '../src/pc-control/windows';
import {createPcApplicationLauncher} from '../src/pc-control/launch';
import {PC_PERMISSIONS} from '../src/pc-control/types';

function approved(fullAccess=true){
  const auth=new PcAuthorizer({profileId:'pc2-normal'});
  auth.setGrantFromLocalApproval({profileId:'pc2-normal',id:'acceptance-517',expiresAt:null,fullAccess,
    roots:fullAccess?['C:\\','D:\\']:['D:\\fixture'],allowedApps:fullAccess?[]:['notepad.exe'],
    permissions:fullAccess?[...PC_PERMISSIONS.slice(1)]:['desktop.input','desktop.advanced','apps.launch']});
  return auth;
}

test('T24: full-access type forwards Windows paths, URLs and printable Unicode unchanged',async()=>{
  const typed:string[]=[];
  const desktop=createPcWindowsController({authorizer:approved(),isInteractive:async()=>true,
    runHelper:async(action,args)=>{
      if(action==='list')return [{id:'123',title:'Notepad',processName:'notepad.exe'}];
      if(action==='type')typed.push(args.text as string);
      return {ok:true};
    }});
  const samples=['D:\\PC2-Test\\a1\\notdefteri3.txt','file:///D:/PC2-Test/sayfalar/form.html',
    'https://example.com/a?q=şğışöüç&x=1#%22',String.raw`\ : / . - _ ~ ' " # % & + = , ; [ ] { } < > | * ? $ ^ \` @ !`,
    'Merhaba 😀 🧪 ş ğ ı ö ü ç'];
  for(const text of samples)expect(await desktop.pcDesktopInput({windowId:'123',action:'type',text})).toEqual({ok:true});
  expect(typed).toEqual(samples);
  for(const text of ['a\nb','\t','\u0000','\u007f','x'.repeat(301)])
    await expect(desktop.pcDesktopInput({windowId:'123',action:'type',text})).rejects.toMatchObject({code:'pc_invalid_argument'});
});

test('T24: selective input retains its strict character policy',async()=>{
  const desktop=createPcWindowsController({authorizer:approved(false),isInteractive:async()=>true,
    runHelper:async action=>action==='list'?[{id:'123',title:'Notepad',processName:'notepad.exe'}]:{ok:true}});
  await expect(desktop.pcDesktopInput({windowId:'123',action:'type',text:'D:\\fixture\\file.txt'}))
    .rejects.toMatchObject({code:'pc_invalid_argument'});
});

test('T23: missing Notepad document has file-not-found code, existing document launches',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'pc2-t23-'));
  const existing=join(folder,'exists.txt');writeFileSync(existing,'ok');
  const launch=createPcApplicationLauncher({authorizer:approved(),resolve:()=> 'C:\\Windows\\System32\\notepad.exe',spawnApp:()=>{}});
  await expect(launch.launchPcApp('notepad',undefined,join(folder,'missing.txt')))
    .rejects.toMatchObject({code:'pc_file_not_found'});
  expect(await launch.launchPcApp('notepad',undefined,existing)).toMatchObject({launched:true});
});

test('T31: Chrome handoff returns launched window and truthful focus result',async()=>{
  let lists=0;
  const launch=createPcApplicationLauncher({authorizer:approved(),
    resolve:()=> 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',spawnApp:()=>{},
    windowHelper:async action=>{
      if(action==='list'){
        lists++;
        return lists<19?[{id:'987',title:'Other browser',processName:'chrome.exe'}]:[
          {id:'987',title:'Other browser',processName:'chrome.exe'},
          {id:'456',title:'Local Form',processName:'chrome.exe'}];
      }
      if(action==='activate')return {ok:false,reason:'focus_required'};
      throw Error('unexpected action');
    }});
  expect(await launch.launchPcApp('chrome.exe','https://example.com/',undefined,'D:\\PC2-Browser-517'))
    .toMatchObject({launched:true,app:'chrome.exe',windowId:'456',focused:false});
  expect(lists).toBeGreaterThanOrEqual(19);
});

test('T31: successful spawn without observable new window never misidentifies an existing Chrome tab',async()=>{
  const launch=createPcApplicationLauncher({authorizer:approved(),
    resolve:()=> 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',spawnApp:()=>{},
    windowHelper:async action=>action==='list'?[{id:'987',title:'Other browser',processName:'chrome.exe'}]:{ok:true}});
  expect(await launch.launchPcApp('chrome','https://example.com/'))
    .toMatchObject({launched:true,app:'chrome.exe',focused:false});
});

test('T23: owned Notepad right-click menu receives Esc through the same helper window contract',async()=>{
  const calls:{action:string;args:Record<string,unknown>}[]=[];
  let menuOpen=false;
  const desktop=createPcWindowsController({authorizer:approved(),isInteractive:async()=>true,
    runHelper:async(action,args)=>{
      if(action==='list')return [{id:'123',title:'Notepad',processName:'notepad.exe'}];
      if(action==='right_click'){menuOpen=true;}
      if(action==='key'){
        expect(menuOpen).toBe(true);
        expect(args.key).toBe('ESC');
        menuOpen=false;
      }
      calls.push({action,args});return {ok:true};
    }});
  await desktop.pcDesktopInput({windowId:'123',action:'right_click',x:30,y:40});
  await desktop.pcDesktopInput({windowId:'123',action:'key',key:'Escape'});
  expect(menuOpen).toBe(false);
  expect(calls.filter(c=>c.action!=='list').map(c=>c.action)).toEqual(['right_click','key']);
  expect(calls.every(c=>c.args.windowId==='123'&&c.args.allowFocus===true)).toBe(true);
});
