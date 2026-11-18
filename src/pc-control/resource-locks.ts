import {randomUUID} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {existsSync} from 'node:fs';
import {PcAccessDeniedError,PcAuthorizer} from './authorization';
import {PcOperationError} from './errors';
import {PC_RESOURCE_PROTOCOL,assertCompatiblePcResourcePeers,type PcPeerEvidence} from './resource-protocol';
import type {PcPermission,PcProfileId} from './types';
type ProcessState={state:'alive'|'dead'|'unknown';pid:number;startTime?:string};
type NativeLease={readBytes(max:number):Buffer;writeBytes(bytes:Buffer):void;close():void};
interface NativeApi {
  ensurePrivateDirectory(path:string,sid:string):void;
  acquireExclusivePrivateFile(path:string,sid:string):NativeLease;
  inspectProcess(pid:number):ProcessState;
  inputHelpersAbsent(operation:'desktop-input'|'adb',ownerStartTime:string):boolean;
}
type Operation='job'|'terminal'|'desktop-input'|'adb';
type RecoveryEvent={operation:Operation;reason:'owner_dead'|'pid_reused'};
type RecoveryLog=(event:RecoveryEvent)=>void;
const recoveryRequired=()=>new PcOperationError('pc_resource_recovery_required',{reason:'Kaynak kilidi doğrulanamadı. Feno Bridge yerel yöneticisine başvurun; kilidi elle silmeyin.'});
// Long-running terminal builds must not monopolize the short-lived input planes.
// Jobs and terminals still serialize against one another; input classes remain
// exclusive within each class and use the same per-user private ACL and peer protocol.
export function pcResourceLockFile(operation:Operation):string {
  return PC_RESOURCE_PROTOCOL+(operation==='desktop-input'?'.desktop-input':operation==='adb'?'.adb':'')+'.lock';
}
export interface PcResourceOptions {
  directory:string;userSid:string;profileId:PcProfileId;authorizer:PcAuthorizer;
  operation:Operation;operationId:string;observePeers:()=>PcPeerEvidence;
  signal?:AbortSignal;timeoutMs?:number;
  onRecovered?:RecoveryLog;
}
type Owner={profileId:PcProfileId;grantId:string;operationId:string;pid:number;startTime:string};
type RecordState={schema:1;protocol:typeof PC_RESOURCE_PROTOCOL;generation:string;state:'held'|'released';owner:Owner;operation?:Operation};
const requirements:Record<Operation,readonly Exclude<PcPermission,'status'>[]>={
  job:['jobs'],terminal:['jobs','terminal.exec'],'desktop-input':['desktop.input'],adb:['adb'],
};
function nativeApi():NativeApi {
  if(process.platform!=='win32'||!process.versions.bun)throw new PcAccessDeniedError();
  return require('../../launcher/electron/private-acl-native.cjs') as NativeApi;
}
function authorize(options:PcResourceOptions):string {
  if(!options||options.profileId!==options.authorizer?.profileId||!isAbsolute(options.directory)
    ||typeof options.operationId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(options.operationId)
    ||!Object.hasOwn(requirements,options.operation))throw new PcAccessDeniedError();
  let id='';for(const permission of requirements[options.operation])id=options.authorizer.assert(permission).id;return id;
}
function readRecord(lease:NativeLease):RecordState|undefined {
  try{
    const bytes=lease.readBytes(8192);if(!bytes.length)return undefined;
    const r=JSON.parse(bytes.toString('utf8')) as RecordState;
    if(r.schema!==1||r.protocol!==PC_RESOURCE_PROTOCOL||!['held','released'].includes(r.state)
      ||typeof r.generation!=='string'||!r.generation||!r.owner||!['pc2-normal','pc2-dev'].includes(r.owner.profileId)
      ||typeof r.owner.grantId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(r.owner.grantId)
      ||typeof r.owner.operationId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(r.owner.operationId)
      ||!Number.isInteger(r.owner.pid)||r.owner.pid<1||r.owner.pid>0xffffffff||typeof r.owner.startTime!=='string'||!/^\d{1,24}$/.test(r.owner.startTime)
      ||(r.operation!==undefined&&!Object.hasOwn(requirements,r.operation)))throw Error();
    return r;
  }catch{throw recoveryRequired();}
}
const writeRecord=(lease:NativeLease,r:RecordState)=>lease.writeBytes(Buffer.from(JSON.stringify(r)));
function recoverAbandoned(api:NativeApi,lease:NativeLease,previous:RecordState|undefined,operation:Operation,onRecovered?:RecoveryLog){
  if(previous?.state!=='held')return;
  if(previous.operation&&pcResourceLockFile(previous.operation)!==pcResourceLockFile(operation))throw recoveryRequired();
  let reason:RecoveryEvent['reason'];
  try{
    const owner=api.inspectProcess(previous.owner.pid);
    if(owner.state==='dead')reason='owner_dead';
    else if(owner.state==='alive'&&owner.startTime&&owner.startTime!==previous.owner.startTime)reason='pid_reused';
    else throw recoveryRequired();
    // Jobs and terminal shells are assigned atomically to a non-inheritable
    // KILL_ON_JOB_CLOSE job. Explicitly detached GUI children are not leased.
    // Legacy input helpers have no such containment: require a complete
    // native snapshot proving no matching helper remains.
    if((operation==='desktop-input'||operation==='adb')&&!api.inputHelpersAbsent(operation,previous.owner.startTime))throw recoveryRequired();
  }catch{throw recoveryRequired();}
  writeRecord(lease,{...previous,state:'released'});
  try{onRecovered?.({operation:previous.operation??operation,reason});}catch{/* recovery must not depend on logging */}
}
/** Startup maintenance only; never creates a journal or bypasses an OS lease. */
export function recoverAbandonedPcResources(directory:string,userSid:string,onRecovered?:RecoveryLog){
  if(!isAbsolute(directory)||!existsSync(directory))return;
  const api=nativeApi();
  for(const operation of ['job','desktop-input','adb'] as const){
    const file=join(directory,pcResourceLockFile(operation));
    if(!existsSync(file))continue;
    let lease:NativeLease|undefined;
    try{lease=api.acquireExclusivePrivateFile(file,userSid);recoverAbandoned(api,lease,readRecord(lease),operation,onRecovered);}
    catch{/* Busy, unreadable or unproven records remain untouched. */}
    finally{lease?.close();}
  }
}
function checkCancelled(options:PcResourceOptions){if(options.signal?.aborted)throw new PcOperationError('pc_resource_cancelled');}
async function pause(ms:number,signal?:AbortSignal){
  await new Promise<void>((resolve,reject)=>{
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();};
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new PcOperationError('pc_resource_cancelled'));};
    const timer=setTimeout(finish,ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
export interface PcHostLease {readonly generation:string;releaseAfterExit(exitProof:Promise<void>):Promise<void>}
/** OS sharing lock plus durable owner journal. No remote grant, stealing TTL, or process killing. */
export async function acquirePcHostLease(options:PcResourceOptions):Promise<PcHostLease> {
  const grantId=authorize(options);checkCancelled(options);
  assertCompatiblePcResourcePeers(options.observePeers?.());
  const timeout=options.timeoutMs??0;
  if(!Number.isFinite(timeout)||timeout<0||timeout>30000)throw new PcAccessDeniedError();
  const api=nativeApi(),deadline=performance.now()+timeout;
  api.ensurePrivateDirectory(options.directory,options.userSid);
  let waiting=false;
  for(;;){
    if(waiting&&performance.now()>=deadline)throw new PcOperationError('pc_resource_timeout');
    checkCancelled(options);if(authorize(options)!==grantId)throw new PcAccessDeniedError();
    assertCompatiblePcResourcePeers(options.observePeers?.());
    let held:NativeLease;
    try{held=api.acquireExclusivePrivateFile(join(options.directory,pcResourceLockFile(options.operation)),options.userSid);}
    catch(error){
      if((error as {code?:string}).code!=='pc_resource_busy')throw error;
      if(timeout===0)throw new PcOperationError('pc_resource_busy');
      if(performance.now()>=deadline)throw new PcOperationError('pc_resource_timeout');
      waiting=true;await pause(Math.min(25,Math.max(1,deadline-performance.now())),options.signal);continue;
    }
    try{
      checkCancelled(options);if(authorize(options)!==grantId)throw new PcAccessDeniedError();
      const previous=readRecord(held);
      recoverAbandoned(api,held,previous,options.operation,options.onRecovered);
      const self=api.inspectProcess(process.pid);
      if(self.state!=='alive'||!self.startTime)throw new PcOperationError('pc_resource_recovery_required');
      const record:RecordState={schema:1,protocol:PC_RESOURCE_PROTOCOL,generation:randomUUID(),state:'held',operation:options.operation,owner:{profileId:options.profileId,grantId,operationId:options.operationId,pid:process.pid,startTime:self.startTime}};
      writeRecord(held,record);
      let completed=false,pending:Promise<void>|undefined;
      return Object.freeze({generation:record.generation,
        releaseAfterExit(exitProof:Promise<void>){
          if(pending)return pending;
          if(!exitProof||typeof exitProof.then!=='function')return Promise.reject(new PcOperationError('pc_resource_recovery_required'));
          if(completed)return Promise.resolve();
          pending=Promise.resolve(exitProof).then(()=>{
            writeRecord(held,{...record,state:'released'});held.close();completed=true;
          }).catch(error=>{pending=undefined;throw error;});return pending;
        },
      });
    }catch(error){held.close();throw error;}
  }
}
/** Local maintenance only. Confirmation and closure proof cannot be supplied as JSON/MCP data. */
export async function recoverPcHostResource(options:PcResourceOptions&{
  expectedGeneration:string;confirmLocally:(owner:Readonly<{profileId:PcProfileId;pid:number;startTime:string}>)=>Promise<boolean>;
  exitProof:Promise<void>;
}):Promise<void>{
  authorize(options);
  if(typeof options.confirmLocally!=='function'||!options.exitProof||typeof options.exitProof.then!=='function')throw new PcAccessDeniedError();
  const api=nativeApi();api.ensurePrivateDirectory(options.directory,options.userSid);
  const held=api.acquireExclusivePrivateFile(join(options.directory,pcResourceLockFile(options.operation)),options.userSid);
  try{
    const record=readRecord(held);
    if(!record||record.state!=='held'||record.generation!==options.expectedGeneration)throw new PcOperationError('pc_resource_recovery_required');
    if(record.owner.profileId!==options.profileId)throw new PcAccessDeniedError();
    const ownerDied=()=>{
      const state=api.inspectProcess(record.owner.pid);
      return state.state==='dead'||(state.state==='alive'&&!!state.startTime&&state.startTime!==record.owner.startTime);
    };
    if(!ownerDied())throw new PcOperationError('pc_resource_recovery_required');
    if(await options.confirmLocally(Object.freeze({profileId:record.owner.profileId,pid:record.owner.pid,startTime:record.owner.startTime}))!==true)throw new PcAccessDeniedError();
    await options.exitProof;authorize(options);if(!ownerDied())throw new PcOperationError('pc_resource_recovery_required');
    writeRecord(held,{...record,state:'released'});
  }finally{held.close();}
}
