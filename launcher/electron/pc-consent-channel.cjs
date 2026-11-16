"use strict";
const {createHmac,randomBytes,randomUUID}=require('node:crypto');
const path=require('node:path');
const {assertPcProfileId,validatePcSelection}=require('./pc-profile-policy.cjs');
const KEY_FILE='pc-consent-key',STATE_FILE='pc-consent-state.json',PC_HEARTBEAT_RENEW_AFTER_MS=15000;
function createPcConsentChannel({directory,profileId,files,clock=Date.now}){
  assertPcProfileId(profileId);
  if(!path.isAbsolute(directory)||!files?.writePrivateAtomic||!files?.ensurePrivateDirectory)throw Error('pc_access_denied');
  let key,grant=null,lastAt,lastId,revision=0;
  function publish(){
    if(!key)throw Error('pc_access_denied');const now=clock();if(!Number.isFinite(now))throw Error('pc_access_denied');
    ++revision;
    if(grant&&grant.expiresAt!==null&&grant.expiresAt<=now)grant=null;
    const interrupted=lastAt!==undefined&&(now-lastAt>=PC_HEARTBEAT_RENEW_AFTER_MS||now<lastAt);
    const candidate=grant&&grant.id===lastId&&interrupted?{...grant,id:randomUUID()}:grant;
    const payload={schema:2,profileId,heartbeatAt:now,grant:candidate};
    const signature=createHmac('sha256',key).update(JSON.stringify(payload)).digest('hex');
    files.writePrivateAtomic(path.join(directory,STATE_FILE),JSON.stringify({payload,signature}));
    grant=candidate;lastAt=now;lastId=candidate?.id;
  }
  async function publishAsync(){
    if(!key)throw Error('pc_access_denied');const now=clock();if(!Number.isFinite(now))throw Error('pc_access_denied');
    const publishingRevision=++revision;
    if(grant&&grant.expiresAt!==null&&grant.expiresAt<=now)grant=null;
    const interrupted=lastAt!==undefined&&(now-lastAt>=PC_HEARTBEAT_RENEW_AFTER_MS||now<lastAt);
    const candidate=grant&&grant.id===lastId&&interrupted?{...grant,id:randomUUID()}:grant;
    const payload={schema:2,profileId,heartbeatAt:now,grant:candidate};
    const signature=createHmac('sha256',key).update(JSON.stringify(payload)).digest('hex');
    if(typeof files.writePrivateAtomicAsync==='function')
      await files.writePrivateAtomicAsync(path.join(directory,STATE_FILE),JSON.stringify({payload,signature}));
    else files.writePrivateAtomic(path.join(directory,STATE_FILE),JSON.stringify({payload,signature}));
    // A local synchronous approval/revoke may have committed while the helper
    // was writing. Republish the newer state after that stale helper returns.
    if(publishingRevision!==revision){publish();return;}
    grant=candidate;lastAt=now;lastId=candidate?.id;
  }
  return {
    start(){files.ensurePrivateDirectory(directory);key=randomBytes(32);grant=null;lastAt=undefined;lastId=undefined;files.writePrivateAtomic(path.join(directory,KEY_FILE),key.toString('hex'));publish();},
    activate(input){
      const now=clock();if(!key||!input||input.profileId!==profileId||typeof input.id!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.id))throw Error('pc_access_denied');
      validatePcSelection({durationMs:input.expiresAt===null?null:input.expiresAt-now,...(input.fullAccess===true?{fullAccess:true}:{}),roots:input.roots,permissions:input.permissions,allowedApps:input.allowedApps});
      if(input.fullAccess===true&&profileId!=='pc2-normal')throw Error('pc_access_denied');
      grant={profileId,id:input.id,expiresAt:input.expiresAt,...(input.fullAccess===true?{fullAccess:true}:{}),roots:[...input.roots],permissions:[...input.permissions],allowedApps:[...input.allowedApps]};publish();
    },
    async activateAsync(input){
      const now=clock();if(!key||!input||input.profileId!==profileId||typeof input.id!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.id))throw Error('pc_access_denied');
      validatePcSelection({durationMs:input.expiresAt===null?null:input.expiresAt-now,...(input.fullAccess===true?{fullAccess:true}:{}),roots:input.roots,permissions:input.permissions,allowedApps:input.allowedApps});
      if(input.fullAccess===true&&profileId!=='pc2-normal')throw Error('pc_access_denied');
      grant={profileId,id:input.id,expiresAt:input.expiresAt,...(input.fullAccess===true?{fullAccess:true}:{}),roots:[...input.roots],permissions:[...input.permissions],allowedApps:[...input.allowedApps]};
      await publishAsync();
    },
    heartbeat:publish,
    heartbeatAsync:publishAsync,
    revoke(){grant=null;publish();},
    async revokeAsync(){grant=null;await publishAsync();},
  };
}
function suspendPcAccess({controller,channel,heartbeat}){if(heartbeat)clearInterval(heartbeat);controller?.suspend();channel?.revoke();}
module.exports={createPcConsentChannel,suspendPcAccess,KEY_FILE,STATE_FILE,PC_HEARTBEAT_RENEW_AFTER_MS};
