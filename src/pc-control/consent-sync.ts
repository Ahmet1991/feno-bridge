import {createHmac,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {PcAuthorizer,validatePcGrant} from './authorization';
import type {PcGrant,PcPrivateFileReader} from './types';
export const PC_HEARTBEAT_MAX_AGE_MS=15000;
export function createPcPolicySync(options:{directory:string;authorizer:PcAuthorizer;files:PcPrivateFileReader;clock?:()=>number;onRevoked?:()=>void|Promise<void>}) {
  const clock=options.clock??Date.now;let lastId:string|undefined,lastGrant:string|undefined;
  const clear=(explicit:boolean)=>{
    const notify=!!lastId||options.authorizer.status().enabled;
    lastId=undefined;lastGrant=undefined;
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
      if(!timingSafeEqual(digest,Buffer.from(signature,'hex')))throw Error();
      const now=clock();
      if(payload.schema!==2||payload.profileId!==options.authorizer.profileId||!Number.isFinite(now)
        ||!Number.isSafeInteger(payload.heartbeatAt)||payload.heartbeatAt>now+2000||now-payload.heartbeatAt>PC_HEARTBEAT_MAX_AGE_MS)throw Error();
      if(payload.grant===null){clear(true);return;}
      const grant=payload.grant as PcGrant;validatePcGrant(grant,now,options.authorizer.profileId);
      const snapshot=JSON.stringify(grant);
      if(lastId===grant.id){if(snapshot!==lastGrant)throw Error();return;}
      if(lastId)clear(false);
      options.authorizer.setGrantFromLocalApproval(grant);lastId=grant.id;lastGrant=snapshot;
    }catch{clear(false);}
  }};
}
