import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {getConfigDir,loadConfig} from '../config';
import {PcAccessDeniedError,PcAuthorizer} from './authorization';
import {createPcPolicySync} from './consent-sync';
import {createLocalPcHost} from './mcp-tools';
import {acquirePcHostLease} from './resource-locks';
import {assertCompatiblePcResourcePeers} from './resource-protocol';
import {createPcPeerRegistry} from './resource-peers';
import type {PcProfileId} from './types';
export function createDefaultPcRuntime(){
  const coreHome=getConfigDir();let profileId:PcProfileId='pc2-normal',configured=false;
  try{profileId=loadConfig().purpose==='dev-harness'?'pc2-dev':'pc2-normal';configured=true;}catch{/* An unconfigured MCP remains usable for existing Codex tools only. */}
  const authorizer=new PcAuthorizer({profileId});
  const layout=require('../../launcher/electron/pc-runtime-paths.cjs').pcRuntimePaths({coreHome,profileId}) as {directory:string;sharedDirectory:string;legacyHomes:Record<PcProfileId,string>;devInstallPaths:string[]};
  let files:any,userSid:string|undefined;
  try{
    const storage=require('../../launcher/electron/private-acl.cjs'),context=storage.getNativeSecurityContext();
    userSid=context.userSid;files=storage.createPrivateFileAccess(userSid);
  }catch{/* Native security unavailable: keep all operations denied; do not use insecure fallbacks. */}
  let retirementStore;
  if(files&&userSid&&profileId==='pc2-normal'){
    try{retirementStore=require('../../launcher/electron/pc-dev-retirement.cjs').createPcDevRetirementStore({
      directory:layout.sharedDirectory,files,
      encryption:require('../../launcher/electron/private-acl.cjs').createWindowsDpapiProtection(userSid,'pc2-normal'),
    });}catch{/* Invalid protection is never evidence of retirement. */}
  }
  const registry=files?createPcPeerRegistry({directory:layout.sharedDirectory,files,legacyHomes:layout.legacyHomes,devInstallPaths:layout.devInstallPaths,retirementStore}):undefined;
  const coordinationReady=()=>{try{assertCompatiblePcResourcePeers(registry?.observe());return true;}catch{return false;}};
  const host=createLocalPcHost(authorizer,{
    coordinationReady,
    runnerDirectory:layout.directory,
    acquireLease:async(operation,operationId)=>{
      if(!files||!userSid||!registry)throw new PcAccessDeniedError();
      return acquirePcHostLease({directory:layout.sharedDirectory,userSid,profileId,authorizer,operation,operationId,observePeers:()=>registry.observe()});
    },
    auditCommand:record=>{
      if(!files)throw new PcAccessDeniedError();
      const target=join(layout.directory,'pc-terminal-audit.jsonl');let previous=Buffer.alloc(0);
      if(existsSync(target))previous=files.readPrivateFile(target,1024*1024);
      const next=Buffer.from(JSON.stringify({...record,profileId})+'\n');
      // The host resource lease serializes writers. Keep a bounded private audit journal.
      files.writePrivateAtomic(target,Buffer.concat([previous.length+next.length>1024*1024?Buffer.alloc(0):previous,next]));
    },
  });
  const sync=files&&configured?createPcPolicySync({directory:layout.directory,files,authorizer,onRevoked:()=>host.revokeActiveJobs()}):undefined;
  let closed=false;
  function refresh(){if(closed)return;if(sync)sync.refresh();else authorizer.revoke();}
  refresh();const timer=setInterval(refresh,100);timer.unref();
  return {authorizer,host,refresh,async close(){if(closed)return;closed=true;clearInterval(timer);authorizer.revoke();await host.revokeActiveJobs();}};
}
