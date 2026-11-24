import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,openSync,readSync,readdirSync,rmSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {PcOperationError,invalidPcArgument} from './errors';
import {PcAccessDeniedError} from './authorization';
import {createPcJobLog,pagePcJobLog,redactPcText} from './job-logs';
import {spawnContainedWindowsProcess,type PcContainedProcess} from './job-native';
import type {PcCommandSpec} from './jobs';

export const CODEX_TASK_STATES=['queued','running','completed','failed','cancelled','timed_out','interrupted'] as const;
export type CodexTaskState=typeof CODEX_TASK_STATES[number];
export type CodexTaskEffort='high'|'medium'|'light';
/** Shared on-disk contract for the MCP host and the launcher. Timestamps are epoch milliseconds. */
export interface CodexTaskRecord {
  taskId:string;title:string;state:CodexTaskState;pid:number|null;
  startedAt:number;updatedAt:number;endedAt:number|null;subagentsStarted:number;
  pidStartedAt?:string;logFirstCursor?:number;error?:string;
}
export interface CodexTaskInput {
  projectRoot:string;title:string;prompt:string;effort?:CodexTaskEffort;maxSubagents?:number;timeoutMinutes?:number;
}
export interface CodexExecutable {command:string;prefixArgs?:string[]}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RETENTION_MS=7*24*60*60*1000,FINAL_BYTES=32*1024,LOG_BYTES=2*1024*1024;
const running=(r:CodexTaskRecord)=>r.state==='queued'||r.state==='running';
type JsonObject=Record<string,unknown>;
export function filterCodexTaskCatalog(value:unknown):{models:JsonObject[]}{
  const models=(value as {models?:unknown})?.models;
  if(!Array.isArray(models))throw new Error('Invalid Codex model catalog');
  const filtered=models.filter((row):row is JsonObject=>!!row&&typeof row==='object'&&typeof row.slug==='string'&&row.slug.startsWith('chatgpt-web/'));
  if(!filtered.length)throw new Error('No ChatGPT Web models in catalog');
  return {models:structuredClone(filtered)};
}
export function codexTaskTabBudget(requested:number,open:number|null):number{
  if(open===null||!Number.isSafeInteger(open)||open<0)return requested;
  if(open>=5)throw new PcOperationError('pc_codex_tabs_full');
  return Math.min(requested,4-open);
}
export function buildCodexTaskCommand(executable:CodexExecutable,options:{
  projectRoot:string;directory:string;port:number;effort:CodexTaskEffort;maxSubagents:number;isGitRepo:boolean;
}):PcCommandSpec{
  const {projectRoot,directory,port,effort,maxSubagents,isGitRepo}=options;
  // Codex's reasoning enum is low, not the Web route's light slug. V1 supports
  // max_depth and max_threads (concurrent spawned threads, excluding the root).
  const args=[...(executable.prefixArgs??[]),'exec','-m','chatgpt-web/'+effort,
    '-c','model_reasoning_effort='+(effort==='light'?'low':effort),
    '-c','model_provider="openai"',
    '-c','openai_base_url='+JSON.stringify('http://127.0.0.1:'+port+'/v1'),
    '-c','model_catalog_json='+JSON.stringify(join(directory,'models.json')),
    '-c','features.multi_agent_v2=false',
    '-c','features.multi_agent='+(maxSubagents>0?'true':'false'),
    ...(maxSubagents>0?['-c','agents.max_threads='+maxSubagents]:[]),
    '-c','agents.max_depth=1',
    ...(!isGitRepo?['--skip-git-repo-check']:[]),
    '-C',projectRoot,'-o',join(directory,'son.md'),'-'];
  return {command:executable.command,args,usesEmulator:false,stdinFile:join(directory,'gorev.md')};
}
/** Discover the installed CLI on PATH. npm's Windows shim launches this JS entry
 * through Node; launching it directly preserves native job containment and stdin. */
export function resolveCodexTaskExecutable():CodexExecutable|undefined{
  const direct=Bun.which('codex.exe');
  if(direct)return {command:direct};
  const shim=Bun.which('codex.cmd');
  if(shim){
    const entry=join(dirname(shim),'node_modules','@openai','codex','bin','codex.js');
    const sibling=join(dirname(shim),'node.exe');
    const node=existsSync(sibling)?sibling:Bun.which('node.exe');
    if(node&&existsSync(entry))return {command:node,prefixArgs:[entry]};
  }
  return undefined;
}
/** Same offline bundled catalog source used by scripts/smoke-codex-catalog.ts. */
export function readBundledCodexTaskCatalog(executable:CodexExecutable):unknown{
  const result=spawnSync(executable.command,[...(executable.prefixArgs??[]),'debug','models','--bundled'],
    {encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});
  if(result.status!==0)throw new Error('Cannot read bundled Codex catalog');
  return JSON.parse(result.stdout);
}
export function isCodexTaskGitRepo(root:string):boolean{
  const git=Bun.which('git.exe')??Bun.which('git');
  if(!git)return false;
  const result=spawnSync(git,['-C',root,'rev-parse','--git-dir'],{encoding:'utf8',timeout:5000,windowsHide:true,stdio:['ignore','pipe','ignore']});
  return result.status===0;
}
type PrivateFiles={
  ensurePrivateDirectory(path:string):unknown;assertPrivatePath(path:string,options?:{directory?:boolean}):unknown;
  readPrivateFile(path:string,maxBytes:number):Buffer;writePrivateAtomic(path:string,data:Buffer):unknown;
  inspectProcess(pid:number):{state:string;startTime?:string};
};
type TaskOptions={
  directory:string;files:PrivateFiles;acquireLock:(path:string)=>{close():void};
  health:()=>Promise<boolean>;activeTabs:()=>Promise<number|null>;
  executable:()=>CodexExecutable|undefined;catalog:(executable:CodexExecutable)=>unknown|Promise<unknown>;
  port:()=>number;isGitRepo?:(root:string)=>boolean;
  spawn?:typeof spawnContainedWindowsProcess;clock?:()=>number;minuteMs?:number;heartbeatMs?:number;
  confirmRequired?:()=>boolean;approvalTimeoutMs?:number;approvalPollMs?:number;
};
const {codexTaskDirectory,readRecord}=require('../../launcher/electron/pc-codex-task-files.cjs') as {
  codexTaskDirectory:(runtimeDirectory:string)=>string;
  readRecord:(files:Pick<PrivateFiles,'readPrivateFile'>,folder:string,taskId:string)=>CodexTaskRecord;
};
export function readCodexTaskRecord(files:Pick<PrivateFiles,'readPrivateFile'>,folder:string,taskId:string):CodexTaskRecord{
  if(!UUID.test(taskId))throw new PcOperationError('pc_codex_task_not_found');
  return readRecord(files,folder,taskId);
}
function publicRecord(r:CodexTaskRecord){
  const {taskId,title,state,pid,startedAt,updatedAt,endedAt,subagentsStarted}=r;
  return {taskId,title,state,pid,startedAt,updatedAt,endedAt,subagentsStarted};
}
function validateInput(input:CodexTaskInput){
  if(typeof input.title!=='string'||!input.title.trim()||input.title.length>80||input.title.includes('\0'))throw invalidPcArgument('title','length');
  if(typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>65536||input.prompt.includes('\0'))throw invalidPcArgument('prompt','length');
  const effort=input.effort??'high',maxSubagents=input.maxSubagents??3,timeoutMinutes=input.timeoutMinutes??60;
  if(!['high','medium','light'].includes(effort))throw invalidPcArgument('effort','invalid_value');
  if(!Number.isInteger(maxSubagents)||maxSubagents<0||maxSubagents>4)throw invalidPcArgument('maxSubagents','range');
  if(!Number.isInteger(timeoutMinutes)||timeoutMinutes<1||timeoutMinutes>240)throw invalidPcArgument('timeoutMinutes','range');
  return {effort,maxSubagents,timeoutMinutes};
}
export function createCodexTaskManager(options:TaskOptions){
  const {files}=options,clock=options.clock??Date.now,folder=codexTaskDirectory(options.directory);
  const lockPath=join(folder,'task.lock'),taskPath=(id:string,name:string)=>join(folder,id,name);
  type Active={record:CodexTaskRecord;log:ReturnType<typeof createPcJobLog>;child?:PcContainedProcess;
    stop?:'cancelled'|'timed_out'|'interrupted';done:Promise<void>;resolveDone:()=>void;
    lock:{close():void};heartbeat?:ReturnType<typeof setInterval>;timeout?:ReturnType<typeof setTimeout>};
  let active:Active|undefined;
  let starting=false,interruptStart=false,startFinished:Promise<void>|undefined;
  const save=(r:CodexTaskRecord)=>files.writePrivateAtomic(taskPath(r.taskId,'state.json'),Buffer.from(JSON.stringify(r)));
  const read=(id:string)=>readCodexTaskRecord(files,folder,id);
  function all(){
    files.ensurePrivateDirectory(folder);
    const result:CodexTaskRecord[]=[];
    for(const entry of readdirSync(folder,{withFileTypes:true})){
      if(!entry.isDirectory()||!UUID.test(entry.name))continue;
      try{result.push(read(entry.name));}catch{/* Untrusted or incomplete private record. */}
    }
    return result.sort((a,b)=>b.startedAt-a.startedAt);
  }
  function recover(){
    for(const r of all()){
      if(running(r)){
        const process=r.pid===null?{state:'dead'}:files.inspectProcess(r.pid);
        if(process.state==='dead'||(process.state==='alive'&&r.pidStartedAt&&process.startTime&&r.pidStartedAt!==process.startTime)){
          const now=clock();save({...r,state:'interrupted',updatedAt:now,endedAt:now,error:'pc_codex_interrupted'});
        }
      }else if(clock()-r.updatedAt>RETENTION_MS){
        const directory=join(folder,r.taskId);
        files.assertPrivatePath(directory,{directory:true});
        // Only validated task directories under the protected runtime root are pruned.
        rmSync(directory,{recursive:true,force:true});
      }
    }
  }
  function lock(){
    files.ensurePrivateDirectory(folder);
    try{return options.acquireLock(lockPath);}
    catch(error){if((error as {code?:string}).code==='pc_resource_busy')throw new PcOperationError('pc_codex_busy');throw error;}
  }
  // A second MCP instance must never repair a task currently owned by another instance.
  try{const held=lock();try{recover();}finally{held.close();}}catch{/* Retried under the lock on start. */}
  function flush(a:Active){
    const snapshot=a.log.snapshot();
    files.writePrivateAtomic(taskPath(a.record.taskId,'log.txt'),Buffer.from(snapshot.lines.length?snapshot.lines.join('\n')+'\n':''));
    a.record.logFirstCursor=snapshot.firstCursor;
    a.record.updatedAt=clock();save(a.record);
  }
  function requestStop(a:Active,state:NonNullable<Active['stop']>){
    if(!a.stop)a.stop=state;
    a.child?.terminate();
  }
  function finish(a:Active,state:CodexTaskState,error?:string,exitProven=true){
    clearInterval(a.heartbeat);clearTimeout(a.timeout);
    a.log.end();
    const now=clock();a.record={...a.record,state,updatedAt:now,endedAt:now,...(error?{error}:{})};
    try{flush(a);}finally{
      // Failed native exit observation must not let a second task start.
      if(exitProven){a.lock.close();if(active===a)active=undefined;}
      a.resolveDone();
    }
  }
  async function start(input:CodexTaskInput,guard:()=>void=()=>{}){
    const config=validateInput(input);
    if(!statSync(input.projectRoot).isDirectory())throw new PcAccessDeniedError();
    if(active||starting)throw new PcOperationError('pc_codex_busy');
    starting=true;interruptStart=false;
    let notify!:()=>void;startFinished=new Promise<void>(r=>{notify=r;});
    let held:{close():void}|undefined;
    try{
      held=lock();recover();
      if(all().some(running))throw new PcOperationError('pc_codex_busy');
      if(!await options.health())throw new PcOperationError('pc_codex_route_unavailable');
      const executable=options.executable();if(!executable)throw new PcOperationError('pc_codex_not_installed');
      const activeTabs=await options.activeTabs().catch(()=>null);
      const maxSubagents=codexTaskTabBudget(config.maxSubagents,activeTabs);
      const catalog=filterCodexTaskCatalog(await options.catalog(executable));
      if(!catalog.models.some(row=>row.slug==='chatgpt-web/'+config.effort))throw new PcOperationError('pc_codex_route_unavailable');
      guard();if(interruptStart)throw new PcAccessDeniedError();
      const taskId=randomUUID(),directory=join(folder,taskId),now=clock();
      files.ensurePrivateDirectory(directory);
      const write=(name:string,data:string)=>files.writePrivateAtomic(join(directory,name),Buffer.from(data));
      write('gorev.md','# Feno: ChatGPT sohbetinden başlatılan görev\nEn çok '+maxSubagents+' alt ajan kullan. Alt ajanlarda model belirtme.\n\n'+input.prompt);
      write('models.json',JSON.stringify(catalog));write('log.txt','');write('son.md','');
      const record:CodexTaskRecord={taskId,title:input.title,state:'queued',pid:null,startedAt:now,updatedAt:now,endedAt:null,subagentsStarted:0};
      save(record);
      try{
        if(options.confirmRequired?.()){
          const timeout=options.approvalTimeoutMs??120000,deadline=performance.now()+timeout;
          write('approval.request',JSON.stringify({taskId,title:input.title,projectRoot:input.projectRoot,maxSubagents,
            timeoutMinutes:config.timeoutMinutes,promptPreview:Array.from(input.prompt).slice(0,600).join(''),expiresAt:clock()+timeout}));
          let approved=false;
          while(!interruptStart&&performance.now()<deadline){
            guard();
            if(existsSync(taskPath(taskId,'cancel.request')))break;
            if(existsSync(taskPath(taskId,'approval.response'))){
              const response=JSON.parse(files.readPrivateFile(taskPath(taskId,'approval.response'),4096).toString('utf8'));
              approved=response.taskId===taskId&&response.approved===true;break;
            }
            await new Promise(resolve=>setTimeout(resolve,Math.min(options.approvalPollMs??500,Math.max(1,deadline-performance.now()))));
          }
          if(!approved||interruptStart||performance.now()>=deadline)throw new PcOperationError('pc_codex_task_denied');
        }
        guard();if(interruptStart)throw new PcAccessDeniedError();
        if(!await options.health())throw new PcOperationError('pc_codex_route_unavailable');
        guard();if(interruptStart)throw new PcAccessDeniedError();
      }catch(error){
        const endedAt=clock();save({...record,state:interruptStart?'interrupted':'failed',updatedAt:endedAt,endedAt,error:error instanceof Error?error.message:'pc_codex_task_denied'});throw error;
      }
      let resolveDone!:()=>void;
      const log=createPcJobLog(line=>{if(/\bcollab: SpawnAgent\b/.test(line))a.record.subagentsStarted++;});
      const a:Active={record,log,lock:held,done:new Promise<void>(r=>{resolveDone=r;}),resolveDone};
      active=a;held=undefined;
      try{
        const spec=buildCodexTaskCommand(executable,{projectRoot:input.projectRoot,directory,port:options.port(),effort:config.effort,maxSubagents,
          isGitRepo:(options.isGitRepo??isCodexTaskGitRepo)(input.projectRoot)});
        a.child=(options.spawn??spawnContainedWindowsProcess)(spec,input.projectRoot,log.stdout.write,log.stderr.write);
      }catch{
        finish(a,'failed','pc_codex_start_failed');return {taskId,state:a.record.state,maxSubagents,activeTabs};
      }
      const child=a.child;
      // Attach before any state or inspection I/O so a failure cannot orphan the child.
      void child.exited.then(({exitCode})=>{
        finish(a,a.stop??(exitCode===0?'completed':'failed'),a.stop?undefined:exitCode===0?undefined:'Codex exit code '+exitCode);
      },()=>finish(a,a.stop??'failed','pc_codex_exit_unconfirmed',false)).catch(()=>{});
      a.timeout=setTimeout(()=>{try{requestStop(a,'timed_out');}catch{/* Containment stays held until exit. */}},config.timeoutMinutes*(options.minuteMs??60000));
      try{
        a.record.state='running';a.record.pid=child.pid;
        const identity=files.inspectProcess(child.pid);
        if(identity.startTime)a.record.pidStartedAt=identity.startTime;
        flush(a);
        let lastFlush=clock();
        a.heartbeat=setInterval(()=>{
          try{
            if(existsSync(taskPath(taskId,'cancel.request'))&&!a.stop){
              files.assertPrivatePath(taskPath(taskId,'cancel.request'));requestStop(a,'cancelled');
            }
            if(clock()-lastFlush>=(options.heartbeatMs??5000)){flush(a);lastFlush=clock();}
          }catch{try{requestStop(a,'interrupted');}catch{/* Keep the lock. */}}
        },Math.min(500,options.heartbeatMs??5000));
      }catch(error){requestStop(a,'interrupted');await a.done;throw error;}
      return {taskId,state:a.record.state,maxSubagents,activeTabs};
    }finally{held?.close();starting=false;notify();}
  }
  function get(id:string){
    if(!UUID.test(id))throw new PcOperationError('pc_codex_task_not_found');
    if(active?.record.taskId===id)return active.record;
    try{return read(id);}catch{throw new PcOperationError('pc_codex_task_not_found');}
  }
  function finalMessage(id:string){
    const path=taskPath(id,'son.md');files.assertPrivatePath(path);
    const fd=openSync(path,'r');
    try{
      const buffer=Buffer.alloc(FINAL_BYTES+1),n=readSync(fd,buffer,0,buffer.length,0),truncated=n>FINAL_BYTES;
      // StringDecoder omits an incomplete UTF-8 code point at a byte boundary.
      const safe=Buffer.from(redactPcText(new StringDecoder('utf8').write(buffer.subarray(0,Math.min(n,FINAL_BYTES)))));
      return {finalMessage:new StringDecoder('utf8').write(safe.subarray(0,FINAL_BYTES)),finalMessageTruncated:truncated||safe.length>FINAL_BYTES};
    }finally{closeSync(fd);}
  }
  async function wait(id:string,seconds=45){
    if(!Number.isInteger(seconds)||seconds<1||seconds>50)throw invalidPcArgument('waitSeconds','range');
    const deadline=performance.now()+seconds*1000;
    const tabs=options.activeTabs().catch(()=>null);
    let record=get(id);
    while(running(record)&&performance.now()<deadline){
      const remaining=Math.max(0,deadline-performance.now());
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([new Promise<void>(resolve=>{timer=setTimeout(resolve,Math.min(remaining,1000));}),...(active?.record.taskId===id?[active.done]:[])]);}
      finally{clearTimeout(timer);}
      record=get(id);
    }
    return {state:record.state,elapsedSeconds:Math.max(0,Math.floor(((record.endedAt??clock())-record.startedAt)/1000)),subagentsStarted:record.subagentsStarted,
      activeTabs:await tabs,
      ...(record.state==='completed'?finalMessage(id):!running(record)?{error:record.error??record.state}:{})};
  }
  async function cancel(id:string){
    const r=get(id);if(!running(r))return {state:r.state};
    if(active?.record.taskId===id){const a=active;requestStop(a,'cancelled');await a.done;return {state:a.record.state};}
    files.writePrivateAtomic(taskPath(id,'cancel.request'),Buffer.from('cancel'));
    // Another MCP instance owns the process. Report cancelled only after its exit proof.
    const deadline=performance.now()+10000;
    while(performance.now()<deadline){const latest=get(id);if(!running(latest))return {state:latest.state};await new Promise(r=>setTimeout(r,250));}
    return {state:get(id).state};
  }
  async function interrupt(){
    interruptStart=true;if(starting)await startFinished;
    if(active){const a=active;requestStop(a,'interrupted');await a.done;}
  }
  return {start,wait,cancel,interrupt,list:()=>all().map(publicRecord).slice(0,20),
    activeCount:()=>all().filter(running).length,
    logs(id:string,cursor:number){
      if(!Number.isSafeInteger(cursor)||cursor<0)throw invalidPcArgument('cursor','range');
      const record=get(id);
      if(active?.record.taskId===id)return active.log.page(cursor);
      const content=files.readPrivateFile(taskPath(id,'log.txt'),LOG_BYTES).toString('utf8');
      const lines=content?content.slice(0,-1).split('\n'):[];
      return pagePcJobLog(lines,record.logFirstCursor??0,cursor);
    }};
}
export type CodexTaskManager=ReturnType<typeof createCodexTaskManager>;
