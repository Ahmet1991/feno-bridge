"use strict";
const {randomUUID}=require('node:crypto');
const {assertPcProfileId,validatePcSelection,copyPcSelection}=require('./pc-profile-policy.cjs');
const MAX_PC_CONSENT_MS=7200000;
const deny=()=>new Error('pc_access_denied');
function createPcConsentController({profileId,clock=Date.now,confirmLocally,audit=()=>{},store}){
  assertPcProfileId(profileId);if(typeof confirmLocally!=='function'||(store&&store.profileId!==profileId))throw deny();
  let active,pending=false,generation=0,permanentApprovalSaved=false,persistentRevocationPending=false;
  const safeAudit=action=>{try{audit({action,at:clock(),profileId});}catch{}};
  const makeGrant=s=>({profileId,id:randomUUID(),expiresAt:s.durationMs===null?null:clock()+s.durationMs,...(s.fullAccess===true?{fullAccess:true}:{}),roots:[...s.roots],permissions:[...s.permissions],allowedApps:[...s.allowedApps]});
  const copy=g=>({...g,roots:[...g.roots],permissions:[...g.permissions],allowedApps:[...g.allowedApps]});
  const protection=()=>store&&store.isProtectionAvailable()===true;
  const clearPersisted=()=>{try{store?.clear();persistentRevocationPending=false;permanentApprovalSaved=false;}catch(error){persistentRevocationPending=true;throw error;}};
  return {
    activateFullAccess(selection){
      validatePcSelection(selection);
      if(profileId!=='pc2-normal'||selection.fullAccess!==true||pending||persistentRevocationPending||!Number.isFinite(clock())||!protection())throw deny();
      generation++;active=undefined;
      store.save(selection);permanentApprovalSaved=true;
      active=makeGrant(selection);safeAudit('full_access_enabled');return copy(active);
    },
    async approve(selection){
      validatePcSelection(selection);if(selection.fullAccess)throw deny();selection=copyPcSelection(selection);
      if(pending||persistentRevocationPending)throw deny();pending=true;const started=generation;
      try{
        if(selection.durationMs===null&&!protection())throw deny();
        if(await confirmLocally(copyPcSelection(selection))!==true||generation!==started)throw deny();
        if(!Number.isFinite(clock()))throw deny();
        if(selection.durationMs===null){if(!protection())throw deny();store.save(selection);permanentApprovalSaved=true;}
        else{clearPersisted();}
        const grant=makeGrant(selection);active=grant;safeAudit('approved');return copy(grant);
      }catch(error){active=undefined;throw error;}finally{pending=false;}
    },
    restoreTrustedPersistentSelection(selection){
      validatePcSelection(selection);
      if(pending||persistentRevocationPending||!Number.isFinite(clock())||selection.durationMs!==null||!protection()||!store.isTrustedSelection(selection))throw deny();
      active=makeGrant(selection);permanentApprovalSaved=true;safeAudit('restored');return copy(active);
    },
    status(){
      const now=clock();
      if(active&&!Number.isFinite(now)){active=undefined;safeAudit('invalid_clock');}
      else if(active&&active.expiresAt!==null&&active.expiresAt<=now){active=undefined;safeAudit('expired');}
      return {...(active?{enabled:true,expiresAt:active.expiresAt}:{enabled:false}),...(permanentApprovalSaved?{permanentApprovalSaved:true}:{}),...(persistentRevocationPending?{persistentRevocationPending:true}:{})};
    },
    isActiveGrant(id){return typeof id==='string'&&this.status().enabled===true&&active?.id===id;},
    revoke(){generation++;active=undefined;safeAudit('revoked');clearPersisted();},
    suspend(){generation++;active=undefined;},
  };
}
module.exports={createPcConsentController,MAX_PC_CONSENT_MS};
