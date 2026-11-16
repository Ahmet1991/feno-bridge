import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {PcAccessDeniedError,PcAuthorizer} from './authorization';
import {PcOperationError} from './errors';
import {resolveAllowedPath} from './paths';
import {spawnContainedWindowsProcess,type PcContainedProcess} from './job-native';
import {containedWindowsTerminalSpec} from './terminal-containment';
import {createPcJobLog,redactPcText} from './job-logs';
import type {PcHostLease} from './resource-locks';
import type {PcProfileId} from './types';

export type PcJobKind='typecheck'|'unit-tests'|'android-build'|'playback-smoke';
export type PcJobState='queued'|'running'|'succeeded'|'failed'|'cancelled'|'timed_out';
export type PcCommandSpec={command:string;args:readonly string[];usesEmulator:boolean;allowGuiBreakaway?:boolean};
export type PcTerminalAudit={at:number;projectRoot:string;purpose:string;commandHash:string};
const KINDS=new Set<PcJobKind>(['typecheck','unit-tests','android-build','playback-smoke']);
const MAX_TIMEOUT=10*60*1000,HISTORY_TTL=60*60*1000;

/** Shared by all projects and retiring managers of one host; a reservation is held through cleanup. */
export function createPcJobResources(){
  let active=0,emulator=false,terminal=false;
  return {activeJobCount:()=>active,isEmulatorBusy:()=>emulator,hasActiveTerminal:()=>terminal,
    reserve(usesEmulator:boolean,isTerminal:boolean){
      if(isTerminal&&terminal)throw new PcOperationError('pc_terminal_busy');
      if(active>=4)throw new PcOperationError('pc_job_busy');
      if(usesEmulator&&emulator)throw new PcAccessDeniedError();
      active++;if(usesEmulator)emulator=true;if(isTerminal)terminal=true;let released=false;
      return ()=>{if(released)return;released=true;active--;if(usesEmulator)emulator=false;if(isTerminal)terminal=false;};
    }};
}

export function inferPcCommandSpecs(projectRoot:string,platform:NodeJS.Platform=process.platform):Partial<Record<PcJobKind,PcCommandSpec>>{
  const root=realpathSync.native(projectRoot),specs:Partial<Record<PcJobKind,PcCommandSpec>>={};let scripts:Record<string,unknown>={};
  try{
    const manifest=resolveAllowedPath(path.join(root,'package.json'),[root]);
    if(statSync(manifest).size>256*1024)throw Error();const parsed=JSON.parse(readFileSync(manifest,'utf8'));
    if(parsed&&parsed.scripts&&typeof parsed.scripts==='object'&&!Array.isArray(parsed.scripts))scripts=parsed.scripts;
  }catch{/* Locally absent scripts remain denied. */}
  for(const [kind,name] of [['typecheck','typecheck'],['unit-tests','test'],['playback-smoke','playback-smoke']] as const){
    if(typeof scripts[name]==='string'&&(scripts[name] as string).trim())specs[kind]={command:process.execPath,args:['run',name],usesEmulator:kind==='playback-smoke'};
  }
  try{
    const wrapper=resolveAllowedPath(path.join(root,'android',platform==='win32'?'gradlew.bat':'gradlew'),[root]);
    if(!existsSync(wrapper)||!statSync(wrapper).isFile())throw Error();
    specs['android-build']=platform==='win32'?{command:path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'),args:['/d','/s','/c','android\\gradlew.bat assembleDebug'],usesEmulator:true}
      :{command:'./android/gradlew',args:['assembleDebug'],usesEmulator:true};
  }catch{/* No trusted wrapper. */}return specs;
}

interface Job {
  id:string;kind:string;grantId:string;state:PcJobState;createdAt:number;closed:boolean;exitCode?:number;
  child:PcContainedProcess;log:ReturnType<typeof createPcJobLog>;completed:Promise<void>;
  timeout?:ReturnType<typeof setTimeout>;termination?:Promise<void>;
}
export interface PcJobManagerOptions {
  projectRoot:string;profileId:PcProfileId;commandSpecs:Record<string,PcCommandSpec>;
  acquireLease:(operation:'job'|'terminal',operationId:string)=>Promise<PcHostLease>;
  auditCommand:(record:PcTerminalAudit)=>void|Promise<void>;
  resources?:ReturnType<typeof createPcJobResources>;clock?:()=>number;
  jobTimeoutMs?:number;terminalTimeoutMs?:number;
}
export function createPcJobManager(options:PcJobManagerOptions){
  if(!options||!['pc2-normal','pc2-dev'].includes(options.profileId)||typeof options.acquireLease!=='function'||typeof options.auditCommand!=='function')throw new PcAccessDeniedError();
  const root=realpathSync.native(options.projectRoot),clock=options.clock??Date.now,resources=options.resources??createPcJobResources();
  // Local configuration is snapshotted: a caller cannot mutate an in-flight command specification.
  const specs=Object.fromEntries(Object.entries(options.commandSpecs).map(([key,s])=>[key,{...s,args:[...s.args]}]));
  const jobs=new Map<string,Job>();let retiring=false;
  function owner(authorizer:PcAuthorizer,terminal=false):string{
    if(authorizer?.profileId!==options.profileId)throw new PcAccessDeniedError();
    const id=authorizer.assert('jobs').id;if(terminal&&authorizer.assert('terminal.exec').id!==id)throw new PcAccessDeniedError();return id;
  }
  function validateRoot(requested:string,authorizer:PcAuthorizer,grantId:string,terminal:boolean){
    const grant=authorizer.assert('jobs');
    if(owner(authorizer,terminal)!==grantId||resolveAllowedPath(requested,grant.roots,{fullAccess:grant.fullAccess})!==root)throw new PcAccessDeniedError();
  }
  function get(id:string,authorizer:PcAuthorizer):Job{
    const grantId=owner(authorizer);const job=typeof id==='string'?jobs.get(id):undefined;
    if(!job||job.grantId!==grantId)throw new PcAccessDeniedError();
    if(job.kind==='terminal')owner(authorizer,true);return job;
  }
  function timeout(terminal:boolean,requestedSeconds?:number){
    const value=requestedSeconds===undefined?(terminal?options.terminalTimeoutMs:options.jobTimeoutMs)??MAX_TIMEOUT:requestedSeconds*1000;
    if(!Number.isSafeInteger(value)||value<1||value>MAX_TIMEOUT)throw new PcAccessDeniedError();return value;
  }
  async function terminate(job:Job,reason:'cancelled'|'timed_out'='cancelled'):Promise<void>{
    if(job.closed)return;if(job.termination)return job.termination;
    job.state=reason;if(job.timeout)clearTimeout(job.timeout);
    job.termination=(async()=>{job.child.terminate();await job.completed;})();
    try{await job.termination;}catch(error){job.termination=undefined;throw error;}
  }
  async function start(kind:string,requested:string,authorizer:PcAuthorizer,override?:PcCommandSpec,audit?:PcTerminalAudit,requestedSeconds?:number):Promise<{jobId:string}>{
    const terminal=kind==='terminal',grantId=owner(authorizer,terminal);validateRoot(requested,authorizer,grantId,terminal);
    if(retiring)throw new PcAccessDeniedError();const duration=timeout(terminal,requestedSeconds),spec=override??specs[kind];
    if(!spec||typeof spec.command!=='string'||!spec.command||spec.command.includes('\0')||!Array.isArray(spec.args)||spec.args.some(a=>typeof a!=='string'||a.includes('\0'))||typeof spec.usesEmulator!=='boolean')throw new PcAccessDeniedError();
    for(const [id,job] of jobs)if(job.closed&&clock()-job.createdAt>HISTORY_TTL)jobs.delete(id);
    if(jobs.size>=100)throw new PcOperationError('pc_job_history_full');
    const release=resources.reserve(spec.usesEmulator,terminal),id=randomUUID();let lease:PcHostLease|undefined,started=false;
    try{
      lease=await options.acquireLease(terminal?'terminal':'job',id);
      validateRoot(requested,authorizer,grantId,terminal);if(retiring)throw new PcAccessDeniedError();
      if(audit){try{await options.auditCommand(audit);}catch{throw new PcAccessDeniedError();}}
      validateRoot(requested,authorizer,grantId,terminal);if(retiring)throw new PcAccessDeniedError();
      const log=createPcJobLog(),child=spawnContainedWindowsProcess({ ...spec,allowGuiBreakaway:spec.allowGuiBreakaway===true&&terminal&&authorizer.assert('jobs').fullAccess===true },root,b=>log.stdout.write(b),b=>log.stderr.write(b));started=true;
      const job:Job={id,kind,grantId,state:'running',createdAt:clock(),closed:false,child,log,completed:Promise.resolve()};
      jobs.set(id,job);
      const nativeExit=child.exited.then(()=>{});
      // Resource protocol receives the native zero-active-processes observation, never shell exit.
      const heldLease=lease;
      const leaseReleased=Promise.resolve().then(()=>heldLease.releaseAfterExit(nativeExit));
      job.completed=Promise.all([child.exited,leaseReleased]).then(([result])=>{
        log.end();if(job.timeout)clearTimeout(job.timeout);job.closed=true;release();
        job.exitCode=result.exitCode;if(job.state==='running')job.state=result.exitCode===0?'succeeded':'failed';
      });
      // Rejecting a native observation or durable release retains the reservation and job handle.
      void job.completed.catch(()=>{if(job.state==='running')job.state='failed';});
      job.timeout=setTimeout(()=>{void terminate(job,'timed_out').catch(()=>{});},duration);
      return {jobId:id};
    }catch(error){
      if(!started){
        if(lease){
          // No CreateProcess succeeded. This proves the operation has no processes to retain.
          try{await lease.releaseAfterExit(Promise.resolve());}catch(releaseError){throw releaseError;}
        }
        release();
      }
      throw error;
    }
  }
  return {
    isEmulatorBusy:()=>resources.isEmulatorBusy(),hasActiveTerminal:()=>resources.hasActiveTerminal(),activeJobCount:()=>[...jobs.values()].filter(j=>!j.closed).length,
    async startPcJob(input:{kind:PcJobKind;projectRoot:string;timeoutSeconds?:number},authorizer:PcAuthorizer){
      if(!input||!KINDS.has(input.kind))throw new PcAccessDeniedError();return start(input.kind,input.projectRoot,authorizer,undefined,undefined,input.timeoutSeconds);
    },
    async startDeveloperTask(input:{taskId:string;projectRoot:string},authorizer:PcAuthorizer){
      if(!input||typeof input.taskId!=='string'||!/^(?:script:[a-zA-Z0-9:._-]+|android:[a-zA-Z]+|git:[a-z-]+)$/.test(input.taskId))throw new PcAccessDeniedError();
      return start(input.taskId,input.projectRoot,authorizer);
    },
    async startTerminalCommand(input:{projectRoot:string;command:string;purpose:string;timeoutSeconds?:number},authorizer:PcAuthorizer){
      owner(authorizer,true);
      if(!input||typeof input.command!=='string'||!input.command.trim()||input.command.length>2048||input.command.includes('\0')||typeof input.purpose!=='string'||input.purpose.trim().length<3||input.purpose.length>160||/[\x00-\x1f]/.test(input.purpose))throw new PcAccessDeniedError();
      const record={at:clock(),projectRoot:root,purpose:redactPcText(input.purpose),commandHash:createHash('sha256').update(input.command).digest('hex')};
      return start('terminal',input.projectRoot,authorizer,containedWindowsTerminalSpec(input.command),record,input.timeoutSeconds);
    },
    pcJobStatus(id:string,authorizer:PcAuthorizer){const j=get(id,authorizer);return {state:j.state,...(j.exitCode!==undefined?{exitCode:j.exitCode}:{})};},
    pcJobLogs(id:string,cursor=0,authorizer:PcAuthorizer){const j=get(id,authorizer);if(!Number.isSafeInteger(cursor)||cursor<0)throw new PcAccessDeniedError();return j.log.page(cursor);},
    async cancelPcJob(id:string,authorizer:PcAuthorizer){await terminate(get(id,authorizer));},
    async revokeAll(){retiring=true;await Promise.all([...jobs.values()].filter(j=>!j.closed).map(j=>terminate(j)));},
  };
}
