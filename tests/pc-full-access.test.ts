import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PcAuthorizer,validatePcGrant,isValidPcRoot} from '../src/pc-control/authorization';
import {createPcApplicationLauncher} from '../src/pc-control/launch';
import {createPcWindowsController} from '../src/pc-control/windows';
import {resolveAllowedPath} from '../src/pc-control/paths';
import type {PcGrant} from '../src/pc-control/types';
import {defaultConfig} from '../src/config';
import {baseConfig} from '../src/setup';
import {createLocalPcHost,registerPcTools,type PcHost} from '../src/pc-control/mcp-tools';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

const grant:PcGrant={profileId:'pc2-normal',id:'full-access-123',expiresAt:null,fullAccess:true,
  roots:['C:\\','D:\\'],permissions:['files.read','files.write','jobs','terminal.exec','screen.read','screen.full',
  'desktop.input','desktop.advanced','apps.launch','adb','runner','browser','chrome.user'],allowedApps:[]};
test('full grant supports fixed drive roots only for normal profile and all permissions',()=>{
  expect(()=>validatePcGrant(grant,100,'pc2-normal')).not.toThrow();
  expect(()=>validatePcGrant({...grant,profileId:'pc2-dev'},100,'pc2-dev')).toThrow();
  expect(()=>validatePcGrant({...grant,fullAccess:false},100,'pc2-normal')).toThrow();
  expect(()=>validatePcGrant({...grant,permissions:['files.read']},100,'pc2-normal')).toThrow();
  expect(isValidPcRoot('C:\\')).toBe(false);
  expect(isValidPcRoot('C:\\',true)).toBe(true);
});
test('full grant allows unknown executable while selective grant rejects it',async()=>{
  const auth=new PcAuthorizer({profileId:'pc2-normal'});auth.setGrantFromLocalApproval(grant);
  const launched:string[]=[];
  const run=createPcApplicationLauncher({authorizer:auth,resolve:app=>app==='paint.exe'?'C:\\Windows\\System32\\paint.exe':undefined,
    spawnApp:async executable=>{launched.push(executable);}});
  expect(await run.launchPcApp('paint.exe')).toEqual({launched:true,app:'paint.exe'});
  expect(launched).toHaveLength(1);
  auth.revoke();auth.setGrantFromLocalApproval({...grant,id:'selective-456',fullAccess:undefined,permissions:grant.permissions.filter(p=>p!=='chrome.user'),roots:['C:\\Test'],allowedApps:['notepad.exe']});
  await expect(run.launchPcApp('paint.exe')).rejects.toThrow();
});
test('full grant exposes all windows; selective empty application list still exposes none',async()=>{
  const auth=new PcAuthorizer({profileId:'pc2-normal'});auth.setGrantFromLocalApproval(grant);
  const desktop=createPcWindowsController({authorizer:auth,isInteractive:async()=>true,
    runHelper:async()=>[{id:'12',title:'Any app',processName:'paint.exe'}]});
  expect(await desktop.listPcWindows()).toHaveLength(1);
  auth.revoke();auth.setGrantFromLocalApproval({...grant,id:'selective-789',fullAccess:undefined,permissions:grant.permissions.filter(p=>p!=='chrome.user'),roots:['C:\\Test'],allowedApps:[]});
  expect(await desktop.listPcWindows()).toHaveLength(0);
});
test.skipIf(process.platform!=='win32')('full root containment accepts drive root and still rejects an unavailable path',()=>{
  const existing=process.env.SystemRoot||'C:\\Windows';
  expect(resolveAllowedPath(existing,[existing.slice(0,3)],{fullAccess:true})).toBeTruthy();
});
test('setup --full and runtime-upgrade preserve explicit full flag and connector identity',()=>{
  const existing={...defaultConfig('full'),pcFullAccess:true,acknowledgedUnofficialAt:'2026-11-16T00:00:00Z',
    appName:'Custom PC2 Connector',automaticAppName:'Custom PC2 Connector'};
  const full=baseConfig(existing,{mode:'full'});
  expect(full.pcFullAccess).toBe(true);
  expect(full.automaticAppName).toBe('Custom PC2 Connector');
  expect(baseConfig(full,{mode:'full',browserHostDescriptorPath:'C:\\fixture\\launcher.json'}).pcFullAccess).toBe(true);
  expect(existing.pcFullAccess).toBe(true);
  expect(baseConfig({...existing,pcFullAccess:false},{mode:'full'}).pcFullAccess).toBe(false);
});
test('PC tools audit every outcome without logging caller paths, content or input',async()=>{
  const auth=new PcAuthorizer({profileId:'pc2-normal'});auth.setGrantFromLocalApproval(grant);
  const callbacks=new Map<string,(args:unknown)=>Promise<{isError?:boolean;structuredContent?:unknown}>>();
  const records:unknown[]=[];
  const server={registerResource:()=>{},registerTool:(name:string,_options:unknown,handler:(input:unknown)=>Promise<unknown>)=>callbacks.set(name,handler as (input:unknown)=>Promise<{isError?:boolean;structuredContent?:unknown}>)} as unknown as McpServer;
  const host={status:async()=>({platform:'win32'}),readFile:async()=>({content:'test-secret-content'})} as unknown as PcHost;
  registerPcTools(server,{authorizer:auth,host,auditTool:record=>{records.push(record);}});
  expect((await callbacks.get('pc_status')!({})).structuredContent).toMatchObject({ok:true,enabled:true});
  await callbacks.get('pc_read_file')!({path:'C:\\private-sensitive-path'});
  auth.revoke();
  expect((await callbacks.get('pc_read_file')!({path:'C:\\secret-data'})).isError).toBe(true);
  expect(records).toHaveLength(3);
  expect(records).toMatchObject([{tool:'pc_status',outcome:'ok'},{tool:'pc_read_file',outcome:'ok'},
    {tool:'pc_read_file',outcome:'error',code:'pc_access_denied'}]);
  const serialized=JSON.stringify(records);
  expect(serialized).not.toContain('private-sensitive-path');
  expect(serialized).not.toContain('test-secret-content');
  expect(serialized).not.toContain('secret-data');
});
test.skipIf(process.platform!=='win32')('full access identity rotation permits a new terminal and desktop shortcut',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-grant-rotate-'));
  const auth=new PcAuthorizer({profileId:'pc2-normal'});
  auth.setGrantFromLocalApproval({...grant,roots:[root.slice(0,3)]});
  const host=createLocalPcHost(auth,{
    acquireLease:async()=>({generation:'rotation-test',releaseAfterExit:async done=>{await done;}}),
    auditCommand:()=>{},isInteractive:async()=>true,
    windowsHelper:async action=>action==='list'?[{id:'123',title:'Test Notepad',processName:'notepad.exe'}]:{ok:true},
  });
  try{
    const first=await host.startTerminal(root,'cmd.exe /d /c exit 23','first terminal') as {jobId:string};
    for(let i=0;i<200;i++){
      const state=await host.jobStatus(first.jobId) as {state:string;exitCode?:number};
      if(state.state!=='running'){expect(state.exitCode).toBe(23);break;}
      await Bun.sleep(25);
      if(i===199)throw Error('terminal did not exit');
    }
    auth.suspend();auth.setGrantFromLocalApproval({...grant,id:'full-access-rotated',roots:[root.slice(0,3)]});
    const next=await host.startTerminal(root,'cmd.exe /d /c exit 0','rotated terminal') as {jobId:string};
    expect(next.jobId).toBeTruthy();
    expect(await host.desktopInput!({windowId:'123',action:'key',key:'Ctrl+S'})).toEqual({ok:true});
    expect((await host.status() as {fullAccess:boolean}).fullAccess).toBe(true);
  }finally{await host.revokeActiveJobs();}
});
test.skipIf(process.platform!=='win32')('full access Notepad accepts an approved existing file argument',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-notepad-file-'));
  const file=join(root,'large.log');writeFileSync(file,'some local text\n');
  const auth=new PcAuthorizer({profileId:'pc2-normal'});
  auth.setGrantFromLocalApproval({...grant,id:'full-access-notepad',roots:[root.slice(0,3)]});
  const launched:string[][]=[];
  const app=createPcApplicationLauncher({authorizer:auth,
    resolve:()=> 'C:\\Windows\\System32\\notepad.exe',spawnApp:async(_exe,args)=>{launched.push(args);}});
  expect(await app.launchPcApp('notepad.exe',undefined,file)).toMatchObject({launched:true});
  expect(launched).toEqual([[file]]);
});

test.skipIf(process.platform!=='win32')('a surviving job remains accessible after transport identity rotation within its lineage',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-lineage-'));
  const auth=new PcAuthorizer({profileId:'pc2-normal'}),lineageId=randomUUID();
  const scoped={...grant,roots:[root.slice(0,3)],lineageId};
  auth.setGrantFromLocalApproval(scoped);
  const host=createLocalPcHost(auth,{acquireLease:async()=>({generation:'lineage-test',releaseAfterExit:async done=>{await done;}}),auditCommand:()=>{},isInteractive:async()=>true});
  try{
    const first=await host.startTerminal(root,'Write-Output lineage-fixture; Start-Sleep -Seconds 30','lineage fixture') as {jobId:string};
    auth.suspend();host.suspendTransport?.();auth.setGrantFromLocalApproval({...scoped,id:randomUUID()});
    expect(await host.listJobs!()).toMatchObject([{jobId:first.jobId}]);
    expect(await host.jobStatus(first.jobId)).toMatchObject({state:'running'});
    expect(await host.jobLogs(first.jobId,0)).toBeDefined();
    expect(await host.cancelJob(first.jobId)).toEqual({cancelled:true});
    auth.revoke();await host.revokeActiveJobs();auth.setGrantFromLocalApproval({...scoped,id:randomUUID(),lineageId:randomUUID()});
    expect(await host.listJobs!()).toEqual([]);
    await expect(host.jobStatus(first.jobId)).rejects.toThrow();
  }finally{await host.revokeActiveJobs();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
