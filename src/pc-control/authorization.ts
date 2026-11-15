import path from 'node:path';
import { PC_PERMISSIONS, PC_PROFILE_IDS, type PcGrant, type PcPermission, type PcProfileId, type PcStatus } from './types';
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
  if(grant?.fullAccess!==undefined&&typeof grant.fullAccess!=='boolean')throw new PcAccessDeniedError();
  if(full&&(profileId!=='pc2-normal'||grant.profileId!=='pc2-normal'||grant.expiresAt!==null
    ||!Array.isArray(grant.allowedApps)||grant.allowedApps.length!==0
    ||!Array.isArray(grant.permissions)||grant.permissions.length!==PC_PERMISSIONS.length-1
    ||!PC_PERMISSIONS.slice(1).every(p=>grant.permissions.includes(p))
    ||!Array.isArray(grant.roots)||!grant.roots.length||!grant.roots.every(root=>/^[a-z]:\\$/i.test(root))))throw new PcAccessDeniedError();
  if(!grant||typeof grant!=='object'||grant.profileId!==profileId||!PC_PROFILE_IDS.includes(profileId)
    ||typeof grant.id!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(grant.id)||!Number.isFinite(now)
    ||(grant.expiresAt!==null&&(!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=now||grant.expiresAt>now+MAX_PC_GRANT_MS))
    ||!Array.isArray(grant.permissions)||grant.permissions.length<1||grant.permissions.length>PC_PERMISSIONS.length
    ||new Set(grant.permissions).size!==grant.permissions.length||!grant.permissions.every(p=>PC_PERMISSIONS.includes(p))
    ||!Array.isArray(grant.roots)||grant.roots.length>(full?26:16)||!grant.roots.every(root=>isValidPcRoot(root,full))
    ||!Array.isArray(grant.allowedApps)||grant.allowedApps.length>32||!grant.allowedApps.every(app=>typeof app==='string'&&/^[a-zA-Z0-9_. -]{1,100}$/.test(app)))throw new PcAccessDeniedError();
}
function copy(grant:PcGrant):PcGrant{return {profileId:grant.profileId,id:grant.id,expiresAt:grant.expiresAt,...(grant.fullAccess===true?{fullAccess:true}:{}),roots:[...grant.roots],permissions:[...grant.permissions],allowedApps:[...grant.allowedApps]};}
export class PcAuthorizer {
  readonly profileId:PcProfileId;
  private active:PcGrant|undefined;
  private readonly seenIds=new Set<string>();
  private readonly clock:()=>number;
  constructor(options:{profileId:PcProfileId;clock?:()=>number}) {
    if(!options||!PC_PROFILE_IDS.includes(options.profileId))throw new PcAccessDeniedError();
    this.profileId=options.profileId;this.clock=options.clock??Date.now;
  }
  setGrantFromLocalApproval(grant:PcGrant):void {
    validatePcGrant(grant,this.clock(),this.profileId);
    if(this.seenIds.has(grant.id))throw new PcAccessDeniedError();
    this.seenIds.add(grant.id);this.active=copy(grant);
  }
  revoke():void{this.active=undefined;}
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
