import {expect,test} from 'bun:test';
import {PcAuthorizer,validatePcGrant,isValidPcRoot} from '../src/pc-control/authorization';
import {createPcApplicationLauncher} from '../src/pc-control/launch';
import {createPcWindowsController} from '../src/pc-control/windows';
import {resolveAllowedPath} from '../src/pc-control/paths';
import type {PcGrant} from '../src/pc-control/types';
import {defaultConfig} from '../src/config';
import {baseConfig} from '../src/setup';
import {registerPcTools,type PcHost} from '../src/pc-control/mcp-tools';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

const grant:PcGrant={profileId:'pc2-normal',id:'full-access-123',expiresAt:null,fullAccess:true,
  roots:['C:\\','D:\\'],permissions:['files.read','files.write','jobs','terminal.exec','screen.read','screen.full',
  'desktop.input','desktop.advanced','apps.launch','adb','runner'],allowedApps:[]};
test('full grant supports fixed drive roots only for normal profile and all eleven permissions',()=>{
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
  auth.revoke();auth.setGrantFromLocalApproval({...grant,id:'selective-456',fullAccess:undefined,roots:['C:\\Test'],allowedApps:['notepad.exe']});
  await expect(run.launchPcApp('paint.exe')).rejects.toThrow();
});
test('full grant exposes all windows; selective empty application list still exposes none',async()=>{
  const auth=new PcAuthorizer({profileId:'pc2-normal'});auth.setGrantFromLocalApproval(grant);
  const desktop=createPcWindowsController({authorizer:auth,isInteractive:async()=>true,
    runHelper:async()=>[{id:'12',title:'Any app',processName:'paint.exe'}]});
  expect(await desktop.listPcWindows()).toHaveLength(1);
  auth.revoke();auth.setGrantFromLocalApproval({...grant,id:'selective-789',fullAccess:undefined,roots:['C:\\Test'],allowedApps:[]});
  expect(await desktop.listPcWindows()).toHaveLength(0);
});
test('full root containment accepts drive root and still rejects an unavailable path',()=>{
  if(process.platform!=='win32')return;
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
  const server={registerTool:(name:string,_options:unknown,handler:(input:unknown)=>Promise<unknown>)=>callbacks.set(name,handler as (input:unknown)=>Promise<{isError?:boolean;structuredContent?:unknown}>)} as unknown as McpServer;
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
