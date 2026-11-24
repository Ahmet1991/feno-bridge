import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildCodexTaskCommand,codexTaskTabBudget,createCodexTaskManager,filterCodexTaskCatalog} from '../src/pc-control/codex-tasks';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {PC_FULL_PERMISSIONS} from '../src/pc-control/types';
import type {PcCommandSpec} from '../src/pc-control/jobs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerPcTools,type PcHost} from '../src/pc-control/mcp-tools';
import {spawnContainedWindowsProcess} from '../src/pc-control/job-native';

const catalog={models:[{slug:'gpt-6'},{slug:'chatgpt-web/high'},{slug:'chatgpt-web/medium'},{slug:'chatgpt-web/light'}]};
test('task command pins web catalog, provider, depth and agent limit; no approval or sandbox overrides',()=>{
  const root=join('D:/','project'),directory=join(root,'task');
  const base={projectRoot:root,directory,port:17841,effort:'light' as const,maxSubagents:3,isGitRepo:false};
  const spec=buildCodexTaskCommand({command:'codex.exe'},base);
  expect(spec.args).toEqual(['exec','-m','chatgpt-web/light','-c','model_reasoning_effort=low','-c','model_provider="openai"',
    '-c','openai_base_url="http://127.0.0.1:17841/v1"','-c','model_catalog_json='+JSON.stringify(join(directory,'models.json')),
    '-c','features.multi_agent_v2=false','-c','features.multi_agent=true','-c','agents.max_threads=3','-c','agents.max_depth=1',
    '--skip-git-repo-check','-C',root,'-o',join(directory,'son.md'),'-']);
  expect(spec.stdinFile).toBe(join(directory,'gorev.md'));
  const zero=buildCodexTaskCommand({command:'node.exe',prefixArgs:['codex.js']},{...base,maxSubagents:0,isGitRepo:true});
  expect(zero.args).toContain('features.multi_agent=false');expect(zero.args).not.toContain('--skip-git-repo-check');
  expect(zero.args.join(' ')).not.toMatch(/sandbox|approval|agents.max_threads/);
});
test('catalog filter and tab budget exclude paid models and reserve a root tab',()=>{
  expect(filterCodexTaskCatalog(catalog).models.map(r=>r.slug)).toEqual(['chatgpt-web/high','chatgpt-web/medium','chatgpt-web/light']);
  expect(()=>filterCodexTaskCatalog({models:[{slug:'gpt-6'}]})).toThrow();
  expect([null,0,1,2,3,4].map(n=>codexTaskTabBudget(3,n))).toEqual([3,3,3,2,1,0]);
  expect(()=>codexTaskTabBudget(3,5)).toThrow('pc_codex_tabs_full');
});
test('full access excludes task permission; explicit extra remains valid',()=>{
  expect(PC_FULL_PERMISSIONS).not.toContain('codex.tasks');
  for(const extra of [false,true]){
    const auth=new PcAuthorizer({profileId:'pc2-normal'});
    auth.setGrantFromLocalApproval({id:'task-test',profileId:'pc2-normal',fullAccess:true,expiresAt:null,roots:['D:\\'],allowedApps:[],
      permissions:extra?[...PC_FULL_PERMISSIONS,'codex.tasks']:[...PC_FULL_PERMISSIONS]});
    if(extra)expect(auth.assert('codex.tasks')).toBeDefined();else expect(()=>auth.assert('codex.tasks')).toThrow('pc_access_denied');
  }
});
function fixture(options:Partial<Parameters<typeof createCodexTaskManager>[0]>={}){
  const directory=mkdtempSync(join(tmpdir(),'codex-task-test-'));
  let locked=false,alive=false,health=true,installed=true,tabs:number|null=2,now=Date.now(),stopCount=0;
  let complete:(r:{exitCode:number})=>void=()=>{},spec:PcCommandSpec|undefined;
  let output:(bytes:Buffer)=>void=()=>{};
  const files={
    ensurePrivateDirectory:(p:string)=>mkdirSync(p,{recursive:true}),
    assertPrivatePath:(_p:string)=>{},
    readPrivateFile:(p:string,max:number)=>{const b=readFileSync(p);if(b.length>max)throw Error('large');return b;},
    writePrivateAtomic:(p:string,b:Buffer)=>writeFileSync(p,b),
    inspectProcess:(_pid:number)=>({state:alive?'alive':'dead',startTime:'fixture'}),
  };
  const make=()=>createCodexTaskManager({directory,files,acquireLock:()=>{
    if(locked)throw Object.assign(Error('busy'),{code:'pc_resource_busy'});locked=true;return {close(){locked=false;}};
  },health:async()=>health,activeTabs:async()=>tabs,executable:()=>installed?{command:'fixture.exe'}:undefined,
  catalog:()=>catalog,port:()=>17841,isGitRepo:()=>true,clock:()=>now,minuteMs:50,heartbeatMs:10,
  spawn:(s,_cwd,stdout)=>{spec=s;output=stdout;alive=true;const exited=new Promise<{exitCode:number}>(resolve=>{complete=r=>{alive=false;resolve(r);};});
    return {pid:1234,exited,terminate(){stopCount++;complete({exitCode:1});}};},...options});
  const manager=make(),input={projectRoot:directory,title:'fixture',prompt:'private prompt'};
  return {directory,files,make,manager,input,setHealth:(v:boolean)=>health=v,setInstalled:(v:boolean)=>installed=v,setTabs:(v:number|null)=>tabs=v,
    tick:()=>{now+=1000;},complete:(code=0)=>complete({exitCode:code}),write:(s:string)=>output(Buffer.from(s)),
    get spec(){return spec!;},get stopCount(){return stopCount;},cleanup:async()=>{await manager.interrupt();rmSync(directory,{recursive:true,force:true});}};
}
test('input and preflight limits, exclusive ownership across managers',async()=>{
  const f=fixture();try{
    for(const invalid of [{title:'x'.repeat(81)},{prompt:'ü'.repeat(32769)},{maxSubagents:5},{maxSubagents:-1},{timeoutMinutes:241},{timeoutMinutes:0}]){
      await expect(f.manager.start({...f.input,...invalid})).rejects.toThrow();
    }
    f.setHealth(false);await expect(f.manager.start(f.input)).rejects.toThrow('pc_codex_route_unavailable');
    f.setHealth(true);f.setInstalled(false);await expect(f.manager.start(f.input)).rejects.toThrow('pc_codex_not_installed');
    f.setInstalled(true);f.setTabs(5);await expect(f.manager.start(f.input)).rejects.toThrow('pc_codex_tabs_full');
    f.setTabs(2);const task=await f.manager.start(f.input);expect(task).toMatchObject({state:'running',maxSubagents:2,activeTabs:2});
    expect(f.manager.activeCount()).toBe(1);
    await expect(f.manager.start(f.input)).rejects.toThrow('pc_codex_busy');
    await expect(f.make().start(f.input)).rejects.toThrow('pc_codex_busy');
    expect(JSON.stringify(f.manager.list())).not.toContain(f.input.prompt);
    await expect(f.manager.wait(task.taskId,51)).rejects.toThrow();
    expect(await f.manager.cancel(task.taskId)).toEqual({state:'cancelled'});expect(f.stopCount).toBe(1);
    expect(f.manager.activeCount()).toBe(0);
  }finally{await f.cleanup();}
});
test('result truncation, masked paginated logs, spawn count and heartbeat',async()=>{
  const f=fixture();try{
    const task=await f.manager.start(f.input);
    const dir=dirname(f.spec.stdinFile!);
    expect(readFileSync(f.spec.stdinFile!,'utf8')).toContain(f.input.prompt);
    expect(JSON.parse(readFileSync(join(dir,'models.json'),'utf8')).models).toHaveLength(3);
    f.write('collab: SpawnAgent\npassword=private-value\n'+'line\n'.repeat(260));
    f.tick();await Bun.sleep(35);
    expect(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')).updatedAt).toBeGreaterThan(f.manager.list()[0]!.startedAt);
    const page=f.manager.logs(task.taskId,0);expect(page.lines).toHaveLength(250);expect(page.lines.join('\n')).not.toContain('private-value');
    expect(f.manager.logs(task.taskId,page.nextCursor).lines).toHaveLength(12);
    writeFileSync(join(dir,'son.md'),'ü'.repeat(20000));f.complete();
    const result=await f.manager.wait(task.taskId,1);expect(result).toMatchObject({state:'completed',subagentsStarted:1,finalMessageTruncated:true});
    if(!('finalMessage' in result))throw Error('missing final message');
    expect(Buffer.byteLength(result.finalMessage)).toBe(32768);expect(f.make().logs(task.taskId,0).lines).toEqual(page.lines);
  }finally{await f.cleanup();}
});
test('launcher cancel.request stops the contained job and records cancelled',async()=>{
  const f=fixture();try{
    const task=await f.manager.start(f.input);
    const directory=join(f.directory,'codex-tasks');
    const {requestCancel}=require('../launcher/electron/pc-codex-task-files.cjs');
    requestCancel(f.files,directory,task.taskId);
    expect(await f.manager.wait(task.taskId,1)).toMatchObject({state:'cancelled'});
    expect(f.stopCount).toBe(1);
  }finally{await f.cleanup();}
});
test('local confirmation approves, denies and expires before spawning',async()=>{
  for(const decision of [true,false,null]){
    const f=fixture({confirmRequired:()=>true,approvalTimeoutMs:250,approvalPollMs:5});
    try{
      const input={...f.input,prompt:'x'.repeat(650)};
      const start=f.manager.start(input);
      // Observe rejection promptly even when no response is written.
      const result=start.then(value=>({value}),error=>({error}));
      const folder=join(f.directory,'codex-tasks');
      const {pendingApprovals,respond}=require('../launcher/electron/pc-codex-task-files.cjs');
      let requests:any[]=[];
      for(let i=0;i<30&&!requests.length;i++){requests=pendingApprovals(f.files,folder);if(!requests.length)await Bun.sleep(5);}
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({title:input.title,projectRoot:input.projectRoot,maxSubagents:2,timeoutMinutes:60,promptPreview:'x'.repeat(600)});
      expect(f.spec).toBeUndefined();
      if(decision!==null)expect(respond(f.files,folder,requests[0],decision)).toBe(true);
      const settled=await result;
      if(decision===true){expect('value' in settled&&settled.value.state).toBe('running');expect(f.spec).toBeDefined();}
      else{expect('error' in settled&&settled.error.code).toBe('pc_codex_task_denied');expect(f.spec).toBeUndefined();expect(f.manager.list()[0]?.state).toBe('failed');}
    }finally{await f.cleanup();}
  }
});
test('MCP task tools require both permissions and are absent in DEV',async()=>{
  for(const profileId of ['pc2-normal','pc2-dev'] as const){
    const auth=new PcAuthorizer({profileId});
    const f=fixture();
    const server=new McpServer({name:'task-fixture',version:'1'});
    registerPcTools(server,{authorizer:auth,host:{codexTasks:f.manager} as unknown as PcHost});
    const [ct,st]=InMemoryTransport.createLinkedPair(),client=new Client({name:'fixture',version:'1'});
    try{
      await server.connect(st);await client.connect(ct);
      const names=(await client.listTools()).tools.filter(t=>t.name.startsWith('pc_codex_task_'));
      if(profileId==='pc2-dev'||process.platform!=='win32'){expect(names).toHaveLength(0);continue;}
      expect(names).toHaveLength(5);
      for(const permissions of [['jobs'],['codex.tasks'],['jobs','codex.tasks']] as const){
        auth.setGrantFromLocalApproval({id:randomUUID(),profileId,expiresAt:null,roots:[f.directory],allowedApps:[],permissions:[...permissions]});
        const result=await client.callTool({name:'pc_codex_task_list',arguments:{}});
        expect(result.structuredContent).toMatchObject(permissions.length===2?{ok:true,data:[]}:{ok:false,code:'pc_access_denied'});
      }
      const invalid=await client.callTool({name:'pc_codex_task_start',arguments:{...f.input,maxSubagents:5}});
      expect(invalid.isError).toBe(true);
    }finally{await client.close();await server.close();await f.cleanup();}
  }
});
const windowsTest=process.platform==='win32'?test:test.skip;
windowsTest('task cancellation and deadline kill actual fake child and grandchild in Windows job',async()=>{
  for(const mode of ['cancel','timeout'] as const){
    const directory=mkdtempSync(join(tmpdir(),'codex-task-tree-')),pids=join(directory,'pids');
    const native=require('../launcher/electron/private-acl-native.cjs');
    const files={ensurePrivateDirectory:(p:string)=>mkdirSync(p,{recursive:true}),assertPrivatePath:(_p:string)=>{},
      readPrivateFile:(p:string,_max:number)=>readFileSync(p),writePrivateAtomic:(p:string,b:Buffer)=>writeFileSync(p,b),
      inspectProcess:(pid:number)=>native.inspectProcess(pid)};
    const manager=createCodexTaskManager({directory,files,acquireLock:()=>({close(){}}),
      health:async()=>true,activeTabs:async()=>null,executable:()=>({command:'fixture.exe'}),catalog:()=>catalog,
      port:()=>17841,isGitRepo:()=>true,minuteMs:3000,heartbeatMs:50,
      spawn:(spec,cwd,out,err)=>spawnContainedWindowsProcess({...spec,command:process.execPath,args:[join(import.meta.dir,'fixtures','pc-jobs-child.ts'),'tree',pids]},cwd,out,err)});
    try{
      const task=await manager.start({projectRoot:directory,title:'tree',prompt:'fixture',timeoutMinutes:mode==='timeout'?1:60});
      const deadline=Date.now()+2500;
      while(!existsSync(pids)||readFileSync(pids,'utf8').trim().split('\n').length<2){
        if(Date.now()>deadline)throw Error('fake descendants did not start');await Bun.sleep(20);
      }
      const children=readFileSync(pids,'utf8').trim().split('\n').map(Number);
      expect(children.every(pid=>native.inspectProcess(pid).state==='alive')).toBe(true);
      const result=mode==='cancel'?await manager.cancel(task.taskId):await manager.wait(task.taskId,5);
      expect(result.state).toBe(mode==='cancel'?'cancelled':'timed_out');
      // Job accounting reaches zero before Windows necessarily signals every
      // terminated process object. Verify eventual kernel exit, not just the job count.
      const exitDeadline=Date.now()+2000;
      while(children.some(pid=>native.inspectProcess(pid).state!=='dead')&&Date.now()<exitDeadline)await Bun.sleep(20);
      expect(children.map(pid=>native.inspectProcess(pid).state)).toEqual(['dead','dead']);
    }finally{await manager.interrupt();await Bun.sleep(100);rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  }
},15000);
test('timeout, close interruption and dead-process startup recovery',async()=>{
  const f=fixture();try{
    const timed=await f.manager.start({...f.input,timeoutMinutes:1});
    expect(await f.manager.wait(timed.taskId,1)).toMatchObject({state:'timed_out'});
    const interrupted=await f.manager.start(f.input);await f.manager.interrupt();
    expect(await f.manager.wait(interrupted.taskId,1)).toMatchObject({state:'interrupted'});
    const id=randomUUID(),old=randomUUID(),base=join(f.directory,'codex-tasks');
    for(const [taskId,state,updatedAt] of [[id,'running',Date.now()],[old,'completed',Date.now()-8*86400000]] as const){
      mkdirSync(join(base,taskId));writeFileSync(join(base,taskId,'state.json'),JSON.stringify({taskId,title:'old',state,pid:1234,startedAt:updatedAt,updatedAt,endedAt:state==='running'?null:updatedAt,subagentsStarted:0}));
    }
    const reopened=f.make();expect(reopened.list().find(r=>r.taskId===id)?.state).toBe('interrupted');expect(existsSync(join(base,old))).toBe(false);
    expect(f.stopCount).toBe(2);
  }finally{await f.cleanup();}
});
