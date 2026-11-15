"use strict";
// The consent channel owns approval. Peer discovery is only a lease prerequisite.
const TRANSIENT=new Set(['pc_private_storage_transient','ETIMEDOUT','EBUSY','EAGAIN']);
const safeCode=error=>typeof error?.code==='string'&&/^(?:pc_private_storage(?:_transient)?|ETIMEDOUT|EBUSY|EAGAIN)$/.test(error.code)
  ?error.code:'pc_private_storage';
function createPcHeartbeatGuard({clock=Date.now,controller,channel,peers,onInactive=()=>{},audit=()=>{}}){
  // The guard is constructed only after peers.start() succeeds.
  let channelFailures=0,firstFailureAt,peerFailures=0,coordinationReady=true,lastAutoStop;
  let channelCleared=false,suspended=false;
  let lastTransientAuditAt=-Infinity;
  function report(action,detail){try{audit({action,at:clock(),...detail});}catch{}}
  function suspend(reason,error){
    if(suspended)return;
    suspended=true;
    lastAutoStop={at:clock(),reason,code:safeCode(error)};
    try{controller.suspend();}finally{onInactive();coordinationReady=false;}
    report('auto_suspended',{reason,code:lastAutoStop.code,consecutiveFailures:channelFailures});
    try{channel.revoke();channelCleared=true;}catch{/* Retry during inactive heartbeats. */}
  }
  function heartbeat(){
    let active=false;
    try{active=controller.status().enabled===true;}catch(error){suspend('controller_security_failure',error);return;}
    if(!active){
      onInactive();channelFailures=0;firstFailureAt=undefined;
      if(!channelCleared)try{channel.revoke();channelCleared=true;}catch(error){
        if(clock()-lastTransientAuditAt>=10000){lastTransientAuditAt=clock();report('heartbeat_transient_error',{reason:'channel_revoke',code:safeCode(error),consecutiveFailures:1});}
      }
    }else try{
      channelCleared=false;suspended=false;
      channel.heartbeat();channelFailures=0;firstFailureAt=undefined;
    }catch(error){
      const now=clock();channelFailures++;
      if(!TRANSIENT.has(error?.code))suspend('channel_security_failure',error);
      else{
        if(firstFailureAt===undefined)firstFailureAt=now;
        if(channelFailures===1||now-lastTransientAuditAt>=10000){
          lastTransientAuditAt=now;report('heartbeat_transient_error',{reason:'channel',code:safeCode(error),consecutiveFailures:channelFailures});
        }
        if(channelFailures>=3&&now-firstFailureAt>=30000)suspend('channel_unavailable',error);
      }
    }
    try{peers.heartbeat();coordinationReady=true;peerFailures=0;}
    catch(error){
      coordinationReady=false;peerFailures++;
      if(peerFailures===1||clock()-lastTransientAuditAt>=10000){
        lastTransientAuditAt=clock();report('heartbeat_transient_error',{reason:'coordination',code:safeCode(error),consecutiveFailures:peerFailures});
      }
    }
  }
  return {heartbeat,status:()=>({channelFailures,peerFailures,coordinationReady,lastAutoStop})};
}
module.exports={createPcHeartbeatGuard};
