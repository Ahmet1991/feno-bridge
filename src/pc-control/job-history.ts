import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {PcProfileId} from './types';

export interface PcJobSummary {
  jobId:string;kind:'terminal'|'job';state:'queued'|'running'|'succeeded'|'failed'|'cancelled'|'timeout'|'interrupted';
  startedAt:number;finishedAt:number|null;exitCode:number|null;projectRoot:string;purpose:string|null;commandHash:string;
}
type ProcessInfo={state:string;startTime?:string};
type Files={ensurePrivateDirectory(path:string):unknown;readPrivateFile(path:string,maxBytes:number):Buffer;
  writePrivateAtomic(path:string,data:Buffer):unknown;removePrivateFile(path:string):unknown;inspectProcess(pid:number):ProcessInfo};
type Entry={profileId:PcProfileId;grantId:string;lineageId?:string;pid:number;startTime:string;summary:PcJobSummary};
const filename=/^(\d{16})-([a-f0-9-]{36})\.json$/i;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function createPcJobHistory({directory,profileId,files,clock=Date.now}:{directory:string;profileId:PcProfileId;files:Files;clock?:()=>number}){
  const folder=join(directory,`pc-job-history-${profileId}`);
  function names(){files.ensurePrivateDirectory(folder);return readdirSync(folder).filter(n=>filename.test(n)).sort().reverse();}
  function safeSummary(s:PcJobSummary):PcJobSummary{
    if(!uuid.test(s.jobId)||!['job','terminal'].includes(s.kind)||!['queued','running','succeeded','failed','cancelled','timeout','interrupted'].includes(s.state)
      ||!Number.isSafeInteger(s.startedAt)||s.startedAt<0||!(s.finishedAt===null||Number.isSafeInteger(s.finishedAt))||!(s.exitCode===null||Number.isSafeInteger(s.exitCode))
      ||typeof s.projectRoot!=='string'||s.projectRoot.length>4096||!(s.purpose===null||(typeof s.purpose==='string'&&s.purpose.length<=160))||!(/^[a-f0-9]{64}$/).test(s.commandHash))throw Error('invalid job summary');
    const {jobId,kind,state,startedAt,finishedAt,exitCode,projectRoot,purpose,commandHash}=s;
    return {jobId,kind,state,startedAt,finishedAt,exitCode,projectRoot,purpose,commandHash};
  }
  const key=(s:PcJobSummary)=>`${String(s.startedAt).padStart(16,'0')}-${s.jobId}.json`;
  const persist=(name:string,entry:Entry)=>files.writePrivateAtomic(join(folder,name),Buffer.from(JSON.stringify(entry),'utf8'));
  return {
    write(grantId:string,summary:PcJobSummary,lineageId?:string){
      const own=files.inspectProcess(process.pid);if(own.state!=='alive'||!own.startTime)throw Error('unknown process identity');
      const s=safeSummary(summary);files.ensurePrivateDirectory(folder);
      persist(key(s),{profileId,grantId,...(lineageId?{lineageId}:{}),pid:process.pid,startTime:own.startTime,summary:s});
      // Independent per-job atomic files avoid losing another MCP process's updates.
      for(const name of names().slice(20)){try{files.removePrivateFile(join(folder,name));}catch{/* Concurrent pruning is harmless. */}}
    },
    list(grantId:string,lineageId?:string):PcJobSummary[]{
      const result:PcJobSummary[]=[];
      for(const name of names().slice(0,20)){
        try{
          const entry=JSON.parse(files.readPrivateFile(join(folder,name),16384).toString('utf8')) as Entry;
          if(entry.profileId!==profileId||(entry.lineageId!==undefined?(!uuid.test(entry.lineageId)||entry.lineageId!==lineageId):entry.grantId!==grantId)||!Number.isSafeInteger(entry.pid)||entry.pid<=0||typeof entry.startTime!=='string')continue;
          let s=safeSummary(entry.summary);if(key(s)!==name)continue;
          if(s.state==='queued'||s.state==='running'){
            const owner=files.inspectProcess(entry.pid);
            if(owner.state==='dead'||(owner.state==='alive'&&owner.startTime&&owner.startTime!==entry.startTime)){
              s={...s,state:'interrupted',finishedAt:clock()};
              try{persist(name,{...entry,summary:s});}catch{/* Still report the proven interrupted state. */}
            }
          }
          result.push(s);
        }catch{/* Never trust or expose an unreadable private record. */}
      }
      return result;
    },
  };
}
export type PcJobHistory=ReturnType<typeof createPcJobHistory>;
