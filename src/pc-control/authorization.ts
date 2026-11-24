import path from 'node:path';
import { PC_PERMISSIONS, PC_FULL_PERMISSIONS, PC_PROFILE_IDS, type PcGrant, type PcPermission, type PcProfileId, type PcStatus } from './types';
export const MAX_PC_GRANT_MS=2*60*60*1000;
export class PcAccessDeniedError extends Error {
  readonly code='pc_access_denied';
  constructor(){super('pc_access_denied');this.name='PcAccessDeniedError';}
}
export function isValidPcRoot(root:unknown,allowDriveRoot=false):root is string {
  if(typeof root!=='string'||root.length<2||root.length>1024||root.includes('\0')||root.startsWith('\\\\'))return false;
  if(/^[a-z]:[\\/]/i.test(root))return !root.slice(2).includes(':')
    && (allowDriveRoot||path.win32.normalize(root).toLowerCase()!==path.win32.parse(root).root.toLowerCase())
    && !root.split(/[\\/]/).some(part=>/[ .]$/.test(part));
  return process.platform!=='win32'&&root.startsWith('/')&&!root.startsWith('//')&&path.posix.normalize(root)!=='/';
}
export function validatePcGrant(grant:PcGrant,now:number,profileId:PcProfileId):void {
  const full=grant?.fullAccess===true;
  if(!full&&Array.isArray(grant?.permissions)&&grant.permissions.includes('chrome.user'))throw new PcAccessDeniedError();
  if(grant?.fullAccess!==undefined&&typeof grant.fullAccess!=='boolean')throw new PcAccessDeniedError();
  if(full&&(profileId!=='pc2-normal'||grant.profileId!=='pc2-normal'||grant.expiresAt!==null
    ||!Array.isArray(grant.allowedApps)||grant.allowedApps.length!==0
    ||!Array.isArray(grant.permissions)||grant.permissions.length!==PC_FULL_PERMISSIONS.length+Number(grant.permissions.includes('codex.tasks'))
    ||!PC_FULL_PERMISSIONS.every(p=>grant.permissions.includes(p))
    ||!Array.isArray(grant.roots)||!grant.roots.length||!grant.roots.every(root=>/^[a-z]:\\$/i.test(root))))throw new PcAccessDeniedError();
  if(!grant||typeof grant!=='object'||grant.profileId!==profileId||!PC_PROFILE_IDS.includes(profileId)
    ||typeof grant.id!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(grant.id)||!Number.isFinite(now)
    ||(grant.lineageId!==undefined&&(typeof grant.lineageId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(grant.lineageId)))
    ||(grant.expiresAt!==null&&(!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=now||grant.expiresAt>now+MAX_PC_GRANT_MS))
    ||!Array.isArray(grant.permissions)||grant.permissions.length<1||grant.permissions.length>PC_PERMISSIONS.length
    ||new Set(grant.permissions).size!==grant.permissions.length||!grant.permissions.every(p=>PC_PERMISSIONS.includes(p))
    ||!Array.isArray(grant.roots)||grant.roots.length>(full?26:16)||!grant.roots.every(root=>isValidPcRoot(root,full))
    ||!Array.isArray(grant.allowedApps)||grant.allowedApps.length>32||!grant.allowedApps.every(app=>typeof app==='string'&&/^[a-zA-Z0-9_. -]{1,100}$/.test(app)))throw new PcAccessDeniedError();
}
function copy(grant:PcGrant):PcGrant{return {profileId:grant.profileId,id:grant.id,...(grant.lineageId?{lineageId:grant.lineageId}:{}),expiresAt:grant.expiresAt,...(grant.fullAccess===true?{fullAccess:true}:{}),roots:[...grant.roots],permissions:[...grant.permissions],allowedApps:[...grant.allowedApps]};}
export const jobOwner=(grant:PcGrant)=>grant.lineageId??grant.id;
export class PcAuthorizer {
  readonly profileId:PcProfileId;
  private active:PcGrant|undefined;
  private readonly seenIds=new Map<string,string>();
  private readonly revokedIds=new Set<string>();
  private readonly lineageScopes=new Map<string,string>();
  private readonly revokedLineages=new Set<string>();
  private lastLineage:string|undefined;
  private lastId:string|undefined;
  private readonly clock:()=>number;
  constructor(options:{profileId:PcProfileId;clock?:()=>number}) {
    if(!options||!PC_PROFILE_IDS.includes(options.profileId))throw new PcAccessDeniedError();
    this.profileId=options.profileId;this.clock=options.clock??Date.now;
  }
  setGrantFromLocalApproval(grant:PcGrant):void {
    validatePcGrant(grant,this.clock(),this.profileId);
    const snapshot=JSON.stringify(copy(grant));
    if(this.revokedIds.has(grant.id)||(this.seenIds.has(grant.id)&&this.seenIds.get(grant.id)!==snapshot))throw new PcAccessDeniedError();
    if(grant.lineageId){
      const scope=JSON.stringify([grant.expiresAt,grant.fullAccess===true,[...grant.roots].sort(),[...grant.permissions].sort(),[...grant.allowedApps].sort()]);
      const previous=this.lineageScopes.get(grant.lineageId);
      if(this.revokedLineages.has(grant.lineageId)||(previous!==undefined&&previous!==scope))throw new PcAccessDeniedError();
      this.lineageScopes.set(grant.lineageId,scope);
    }
    if(this.lastLineage&&this.lastLineage!==grant.lineageId)this.revokedLineages.add(this.lastLineage);
    this.lastLineage=grant.lineageId;
    // Replacing a grant permanently retires the old identity, including one
    // which was temporarily suspended during a heartbeat/read interruption.
    if(this.lastId&&this.lastId!==grant.id)this.revokedIds.add(this.lastId);
    this.lastId=grant.id;this.seenIds.set(grant.id,snapshot);this.active=copy(grant);
  }
  suspend():void{this.active=undefined;}
  revoke():void{if(this.lastId)this.revokedIds.add(this.lastId);if(this.lastLineage)this.revokedLineages.add(this.lastLineage);this.active=undefined;this.lastId=undefined;this.lastLineage=undefined;}
  private current(now:number):PcGrant|undefined {
    if(!Number.isFinite(now)||(this.active?.expiresAt!==null&&this.active&&this.active.expiresAt<=now))this.revoke();
    return this.active;
  }
  status(now=this.clock()):PcStatus{const active=this.current(now);return active?{enabled:true,expiresAt:active.expiresAt}:{enabled:false};}
  assert(permission:'status',now?:number):PcGrant|undefined;
  assert(permission:Exclude<PcPermission,'status'>,now?:number):PcGrant;
  assert(permission:PcPermission,now?:number):PcGrant|undefined;
  assert(permission:PcPermission,now=this.clock()):PcGrant|undefined {
    const active=this.current(now);
    if(permission==='status')return active?copy(active):undefined;
    if(!active||!active.permissions.includes(permission))throw new PcAccessDeniedError();return copy(active);
  }
}
