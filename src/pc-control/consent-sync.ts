import {createHmac,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {PcAuthorizer,validatePcGrant} from './authorization';
import type {PcGrant,PcPrivateFileReader} from './types';
export const PC_HEARTBEAT_MAX_AGE_MS=15000;
export function createPcPolicySync(options:{directory:string;authorizer:PcAuthorizer;files:PcPrivateFileReader;clock?:()=>number;onRevoked?:()=>void|Promise<void>;onTransportLost?:()=>void}) {
  const clock=options.clock??Date.now;let lastId:string|undefined,lastGrant:string|undefined,lastLineage:string|undefined,lastKey:string|undefined,requireFreshId=false;
  const clear=(explicit:boolean,preserveJobs=false)=>{
    if(!explicit&&preserveJobs&&lastLineage){
      options.authorizer.suspend();
      try{options.onTransportLost?.();}catch{}
      return;
    }
    const notify=!!lastId||options.authorizer.status().enabled;
    lastId=undefined;lastGrant=undefined;lastLineage=undefined;requireFreshId=false;
    if(explicit)options.authorizer.revoke();else options.authorizer.suspend();
    // Cleanup failures must never keep authorization alive.
    if(notify)try{void Promise.resolve(options.onRevoked?.()).catch(()=>{});}catch{}
  };
  return {refresh(){
    try{
      const key=options.files.readPrivateFile(join(options.directory,'pc-consent-key'),64).toString('utf8');
      if(!/^[a-f0-9]{64}$/.test(key))throw Error();
      const raw=options.files.readPrivateFile(join(options.directory,'pc-consent-state.json'),32768).toString('utf8');
      const {payload,signature}=JSON.parse(raw);
      if(!payload||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))throw Error();
      const digest=createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify(payload)).digest();
      if(!timingSafeEqual(digest,Buffer.from(signature,'hex'))){
        if(lastKey&&lastKey!==key&&lastLineage&&timingSafeEqual(createHmac('sha256',Buffer.from(lastKey,'hex')).update(JSON.stringify(payload)).digest(),Buffer.from(signature,'hex'))){requireFreshId=true;clear(false,true);return;}
        throw Error();
      }
      lastKey=key;
      const now=clock();
      if(payload.schema!==2||payload.profileId!==options.authorizer.profileId||!Number.isFinite(now)
        ||!Number.isSafeInteger(payload.heartbeatAt)||payload.heartbeatAt>now+2000)throw Error();
      if(now-payload.heartbeatAt>PC_HEARTBEAT_MAX_AGE_MS){
        if(payload.grant?.lineageId===lastLineage&&lastLineage&&(payload.grant.expiresAt===null||payload.grant.expiresAt>now)){requireFreshId=true;clear(false,true);return;}
        throw Error();
      }
      if(payload.grant===null){
        if(lastLineage&&payload.continuationLineage===lastLineage){requireFreshId=true;clear(false,true);return;}
        clear(true);return;
      }
      const grant=payload.grant as PcGrant;validatePcGrant(grant,now,options.authorizer.profileId);
      const snapshot=JSON.stringify(grant);
      if(lastId===grant.id){if(snapshot!==lastGrant)throw Error();if(requireFreshId)return;if(!options.authorizer.status().enabled)options.authorizer.setGrantFromLocalApproval(grant);return;}
      if(lastId){
        if(lastLineage&&grant.lineageId===lastLineage){try{options.onTransportLost?.();}catch{}}
        else clear(true);
      }
      options.authorizer.setGrantFromLocalApproval(grant);lastId=grant.id;lastGrant=snapshot;lastLineage=grant.lineageId;requireFreshId=false;
    }catch(error){clear(false,(error as {code?:string})?.code==='pc_private_storage_transient');}
  }};
}
