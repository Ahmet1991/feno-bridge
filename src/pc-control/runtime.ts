import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {getConfigDir,loadConfig} from '../config';
import {PcAccessDeniedError,PcAuthorizer} from './authorization';
import {createPcPolicySync} from './consent-sync';
import {createLocalPcHost} from './mcp-tools';
import {acquirePcHostLease,recoverAbandonedPcResources} from './resource-locks';
import {assertCompatiblePcResourcePeers} from './resource-protocol';
import {createPcPeerRegistry} from './resource-peers';
import type {PcProfileId} from './types';
import {createPcRequestLog} from './request-log';
import {createPcJobHistory} from './job-history';
import {createUserChromeClient} from './chrome';
import {createCodexTaskManager,readBundledCodexTaskCatalog,resolveCodexTaskExecutable} from './codex-tasks';
import {augmentNativeModelCatalog} from '../model-catalog';
import {readCodexModelContextOverride} from '../codex-integration';
import {readLauncherBrowserHostDescriptor} from '../launcher-browser-host';
type ToolAudit={tool:string;at:number;outcome:'ok'|'error';code?:string;reason?:string;fields?:string[]};
export function createDefaultPcRuntime(){
  const coreHome=getConfigDir();let profileId:PcProfileId='pc2-normal',configured=false,probes=false;
  try{const config=loadConfig();profileId=config.purpose==='dev-harness'?'pc2-dev':'pc2-normal';probes=config.pcWidgetProbes===true;configured=true;}catch{/* An unconfigured MCP remains usable for existing Codex tools only. */}
  const authorizer=new PcAuthorizer({profileId});
  const layout=require('../../launcher/electron/pc-runtime-paths.cjs').pcRuntimePaths({coreHome,profileId}) as {directory:string;sharedDirectory:string;legacyHomes:Record<PcProfileId,string>;devInstallPaths:string[]};
  let files:any,userSid:string|undefined;
  try{
    const storage=require('../../launcher/electron/private-acl.cjs'),context=storage.getNativeSecurityContext();
    userSid=context.userSid;files=storage.createPrivateFileAccess(userSid);
  }catch{/* Native security unavailable: keep all operations denied; do not use insecure fallbacks. */}
  let retirementStore:{read():boolean}|undefined;
  if(files&&userSid&&profileId==='pc2-normal'){
    try{retirementStore=require('../../launcher/electron/pc-dev-retirement.cjs').createPcDevRetirementStore({
      directory:layout.sharedDirectory,files,
      encryption:require('../../launcher/electron/private-acl.cjs').createWindowsDpapiProtection(userSid,'pc2-normal'),
    });}catch{/* Invalid protection is never evidence of retirement. */}
  }
  const registry=files?createPcPeerRegistry({directory:layout.sharedDirectory,files,legacyHomes:layout.legacyHomes,devInstallPaths:layout.devInstallPaths,retirementStore}):undefined;
  const coordinationReady=()=>{try{assertCompatiblePcResourcePeers(registry?.observe());return true;}catch{return false;}};
  function writeAudit(name:string,record:object,includeProfile=true){
    if(!files)throw new PcAccessDeniedError();
    const target=join(layout.directory,name);let previous=Buffer.alloc(0);
    if(existsSync(target))previous=files.readPrivateFile(target,1024*1024);
    const next=Buffer.from(JSON.stringify(includeProfile?{...record,profileId}:record)+'\n');
    files.writePrivateAtomic(target,Buffer.concat([previous.length+next.length>1024*1024?Buffer.alloc(0):previous,next]));
  }
  const onRecovered=(event:{operation:string;reason:string})=>writeAudit('pc-resource-audit.jsonl',{event:'pc_control.resource_recovered',...event},false);
  if(files&&userSid&&configured){
    try{recoverAbandonedPcResources(layout.sharedDirectory,userSid,onRecovered);}catch{/* fail closed on subsequent acquisition */}
  }
  const codexTasks=files&&userSid&&configured&&process.platform==='win32'&&profileId==='pc2-normal'?
    createCodexTaskManager({
      directory:layout.directory,files,
      acquireLock:target=>require('../../launcher/electron/private-acl-native.cjs').acquireExclusivePrivateFile(target,userSid),
      health:async()=>{
        try{const config=loadConfig();
          const response=await fetch('http://127.0.0.1:'+config.port+'/healthz',{signal:AbortSignal.timeout(2000)});
          const body=await response.json() as {accepting_turns?:boolean};
          return response.ok&&body.accepting_turns===true;
        }catch{return false;}
      },
      activeTabs:async()=>{
        try{
          const config=loadConfig();if(!config.browserHostDescriptorPath)return null;
          const descriptor=readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath);
          if(descriptor.profile!=='production')return null;
          const response=await fetch(descriptor.control.endpoint+'/v1/session/tab-count',{
            method:'POST',headers:{authorization:'Bearer '+descriptor.control.token,'content-type':'application/json'},
            body:'{}',signal:AbortSignal.timeout(1000)});
          const body=await response.json() as {activeTabs?:number};
          return response.ok&&Number.isSafeInteger(body.activeTabs)&&body.activeTabs!>=0?body.activeTabs!:null;
        }catch{return null;}
      },
      executable:resolveCodexTaskExecutable,
      // Use the same augmentation as /v1/models and the offline source used by
      // smoke-codex-catalog. Pin V1 to make the depth limit effective.
      catalog:executable=>augmentNativeModelCatalog(readBundledCodexTaskCatalog(executable),
        {...loadConfig(),subagentProtocol:'compatibility-v1'},readCodexModelContextOverride()),
      port:()=>loadConfig().port,
      confirmRequired:()=>loadConfig().pcCodexTasksConfirm===true,
    }):undefined;
  const host=createLocalPcHost(authorizer,{
    codexTasks,
    ...(files&&configured&&profileId==='pc2-normal'?{chromeAction:createUserChromeClient(files)}:{}),
    ...(files&&configured?{browserOptions:{directory:join(layout.directory,'pc-browser-profile'),
      ensureDirectory:(directory:string)=>files.ensurePrivateDirectory(directory)}}:{}),
    history:files&&configured?createPcJobHistory({directory:layout.directory,profileId,files}):undefined,
    coordinationReady,
    devMode:()=>profileId==='pc2-dev'?'active':retirementStore?.read()===true?'retired':'unknown',
    runnerDirectory:layout.directory,
    acquireLease:async(operation,operationId)=>{
      if(!files||!userSid||!registry)throw new PcAccessDeniedError();
      return acquirePcHostLease({directory:layout.sharedDirectory,userSid,profileId,authorizer,operation,operationId,observePeers:()=>registry.observe(),onRecovered});
    },
    auditCommand:record=>writeAudit('pc-terminal-audit.jsonl',record),
  });
  const sync=files&&configured?createPcPolicySync({directory:layout.directory,files,authorizer,onRevoked:()=>host.revokeActiveJobs(),onTransportLost:()=>host.suspendTransport?.()}):undefined;
  let closed=false;
  function refresh(){if(closed)return;if(sync)sync.refresh();else authorizer.revoke();}
  // 500 ms is well below the 15 s signed heartbeat limit and avoids
  // continuously contending with the launcher's atomic snapshot replacement.
  refresh();const timer=setInterval(refresh,500);timer.unref();
  return {authorizer,host,refresh,auditTool:(record:ToolAudit)=>writeAudit('pc-tool-audit.jsonl',record),
    requestLog:profileId==='pc2-normal'&&configured?createPcRequestLog(join(layout.directory,'pc-mcp-requests.jsonl')):undefined,
    pcWidgetProbes:profileId==='pc2-normal'&&configured&&probes,
    async close(){if(closed)return;closed=true;clearInterval(timer);authorizer.revoke();await host.revokeActiveJobs();}};
}
