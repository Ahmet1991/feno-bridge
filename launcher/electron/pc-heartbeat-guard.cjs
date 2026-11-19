"use strict";
// The consent channel owns approval. Peer discovery is only a lease prerequisite.
const TRANSIENT=new Set(['pc_private_storage_transient','ETIMEDOUT','EBUSY','EAGAIN','EACCES','EPERM']);
const transient=error=>TRANSIENT.has(error?.code)||[5,32,33].includes(error?.nativeCode);
const safeCode=error=>typeof error?.code==='string'&&/^(?:pc_access_denied|pc_private_storage(?:_transient)?|ETIMEDOUT|EBUSY|EAGAIN)$/.test(error.code)
  ?error.code:'pc_private_storage';
const safeNativeCode=error=>[5,32,33,'ETIMEDOUT','EBUSY','EAGAIN','EACCES','EPERM'].includes(error?.nativeCode)?error.nativeCode:undefined;
const errorDetail=(error,fallback)=>({op:typeof error?.op==='string'&&/^(?:read|write|ensure|assert|remove|quarantine|context|protect|unprotect|protection-check|inspect-process|inspect-dev-launchers)$/.test(error.op)?error.op:fallback,
  ...(safeNativeCode(error)!==undefined?{nativeCode:safeNativeCode(error)}:{})});
function createPcHeartbeatGuard({clock=Date.now,controller,channel,peers,onInactive=()=>{},preserveInactive=()=>false,audit=()=>{}}){
  // The guard is constructed only after peers.start() succeeds.
  let channelFailures=0,firstFailureAt,peerFailures=0,coordinationReady=true,lastAutoStop;
  let channelCleared=false,suspended=false,pendingRevoke,preserveSuspension=false;
  let lastTransientAuditAt=-Infinity;
  let graceUntil=-Infinity,nextChannelAt=-Infinity,nextPeerAt=-Infinity,graceFailures=0,gracePeerFailures=0;
  const backoff=count=>Math.min(4000,250*2**Math.min(count,4));
  function powerEvent(){graceUntil=clock()+60000;channelFailures=0;firstFailureAt=undefined;graceFailures=gracePeerFailures=0;nextChannelAt=nextPeerAt=-Infinity;}
  function report(action,detail){try{audit({action,at:clock(),...detail});}catch{}}
  function suspend(reason,error){
    if(suspended)return;
    suspended=true;
    preserveSuspension=transient(error);
    lastAutoStop={at:clock(),reason,code:safeCode(error),...errorDetail(error,'channel.heartbeat')};
    try{controller.suspend();}finally{onInactive();coordinationReady=false;}
    report('auto_suspended',{reason,code:lastAutoStop.code,...errorDetail(error,'channel.heartbeat'),consecutiveFailures:channelFailures});
    try{
      if(typeof channel.revokeAsync==='function'){
        pendingRevoke=(transient(error)&&channel.suspendAsync?channel.suspendAsync():channel.revokeAsync()).catch(()=>{channelCleared=false;});
      }
      else if(transient(error)&&channel.suspend)channel.suspend();else channel.revoke();
      channelCleared=true;
    }catch{/* Retry during inactive heartbeats. */}
  }
  function channelFailure(error){
    const now=clock();
    if(transient(error)&&now<graceUntil){
      nextChannelAt=now+backoff(++graceFailures);
      if(graceFailures===1||now-lastTransientAuditAt>=10000){
        lastTransientAuditAt=now;report('heartbeat_transient_error',{reason:'channel',code:safeCode(error),...errorDetail(error,'channel.heartbeat'),consecutiveFailures:0});
      }
      return;
    }
    channelFailures++;
    if(!transient(error))suspend('channel_security_failure',error);
    else{
      if(firstFailureAt===undefined)firstFailureAt=now;
      if(channelFailures===1||now-lastTransientAuditAt>=10000){
        lastTransientAuditAt=now;report('heartbeat_transient_error',{reason:'channel',code:safeCode(error),...errorDetail(error,'channel.heartbeat'),consecutiveFailures:channelFailures});
      }
      if(channelFailures>=3&&now-firstFailureAt>=30000)suspend('channel_unavailable',error);
    }
  }
  function peerFailure(error){
    coordinationReady=false;peerFailures++;
    if(transient(error)&&clock()<graceUntil)nextPeerAt=clock()+backoff(++gracePeerFailures);
    if(peerFailures===1||clock()-lastTransientAuditAt>=10000){
      lastTransientAuditAt=clock();report('heartbeat_transient_error',{reason:'coordination',code:safeCode(error),...errorDetail(error,'coordination.heartbeat'),consecutiveFailures:peerFailures});
    }
  }
  function heartbeat(){
    let active=false;
    try{active=controller.status().enabled===true;}catch(error){suspend('controller_security_failure',error);return;}
    if(!active){
      onInactive();channelFailures=0;firstFailureAt=undefined;
      if(!channelCleared)try{if((preserveSuspension||preserveInactive())&&channel.suspend)channel.suspend();else channel.revoke();channelCleared=true;}catch(error){
        if(clock()-lastTransientAuditAt>=10000){lastTransientAuditAt=clock();report('heartbeat_transient_error',{reason:'channel_revoke',code:safeCode(error),...errorDetail(error,'channel.revoke'),consecutiveFailures:1});}
      }
    }else if(clock()>=nextChannelAt||clock()>=graceUntil)try{
      channelCleared=false;suspended=false;preserveSuspension=false;
      channel.heartbeat();channelFailures=0;firstFailureAt=undefined;graceFailures=0;nextChannelAt=-Infinity;
    }catch(error){channelFailure(error);}
    if(clock()>=nextPeerAt||clock()>=graceUntil)try{peers.heartbeat();coordinationReady=true;peerFailures=0;gracePeerFailures=0;nextPeerAt=-Infinity;}
    catch(error){peerFailure(error);}
  }
  async function heartbeatAsync(){
    let active=false;
    try{active=controller.status().enabled===true;}catch(error){suspend('controller_security_failure',error);return;}
    if(!active){
      onInactive();channelFailures=0;firstFailureAt=undefined;
      if(!channelCleared)try{
        if((preserveSuspension||preserveInactive())&&channel.suspendAsync)await channel.suspendAsync();else if(typeof channel.revokeAsync==='function')await channel.revokeAsync();else channel.revoke();
        channelCleared=true;
      }catch(error){if(clock()-lastTransientAuditAt>=10000){lastTransientAuditAt=clock();report('heartbeat_transient_error',{reason:'channel_revoke',code:safeCode(error),...errorDetail(error,'channel.revoke'),consecutiveFailures:1});}}
    }else if(clock()>=nextChannelAt||clock()>=graceUntil)try{
      channelCleared=false;suspended=false;preserveSuspension=false;
      if(typeof channel.heartbeatAsync==='function')await channel.heartbeatAsync();else channel.heartbeat();
      channelFailures=0;firstFailureAt=undefined;graceFailures=0;nextChannelAt=-Infinity;
    }catch(error){channelFailure(error);}
    if(clock()>=nextPeerAt||clock()>=graceUntil)try{
      if(typeof peers.heartbeatAsync==='function')await peers.heartbeatAsync();else peers.heartbeat();
      coordinationReady=true;peerFailures=0;gracePeerFailures=0;nextPeerAt=-Infinity;
    }catch(error){peerFailure(error);}
  }
  return {heartbeat,heartbeatAsync,powerEvent,flushSuspension:async()=>{if(pendingRevoke)await pendingRevoke;},
    status:()=>({channelFailures,peerFailures,coordinationReady,lastAutoStop})};
}
module.exports={createPcHeartbeatGuard,transient,errorDetail,safeCode};
