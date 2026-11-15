"use strict";
// Bun-only Windows backend. No shell, privilege elevation, or execution-policy changes.
const path=require('node:path');
const {randomUUID}=require('node:crypto');
if(process.platform!=='win32' || !process.versions.bun) throw new Error('pc_private_storage');
const {dlopen,ptr,toArrayBuffer}=require('bun:ffi');
const root=process.env.SystemRoot || 'C:\\Windows';
const k=dlopen(path.join(root,'System32/kernel32.dll'),{
  OpenProcess:{args:['u32','bool','u32'],returns:'u64'}, CloseHandle:{args:['u64'],returns:'bool'},
  CreateToolhelp32Snapshot:{args:['u32','u32'],returns:'u64'},
  Process32FirstW:{args:['u64','ptr'],returns:'bool'},Process32NextW:{args:['u64','ptr'],returns:'bool'},
  GetProcessTimes:{args:['u64','ptr','ptr','ptr','ptr'],returns:'bool'},
  WaitForSingleObject:{args:['u64','u32'],returns:'u32'},
  LocalFree:{args:['ptr'],returns:'ptr'}, GetLastError:{args:[],returns:'u32'},
  GetFileAttributesW:{args:['ptr'],returns:'u32'},
  CreateDirectoryW:{args:['ptr','ptr'],returns:'bool'},
  CreateFileW:{args:['ptr','u32','u32','ptr','u32','u32','ptr'],returns:'u64'},
  GetFileInformationByHandleEx:{args:['u64','u32','ptr','u32'],returns:'bool'},
  GetFileSizeEx:{args:['u64','ptr'],returns:'bool'},
  SetFilePointerEx:{args:['u64','i64','ptr','u32'],returns:'bool'}, SetEndOfFile:{args:['u64'],returns:'bool'},
  ReadFile:{args:['u64','ptr','u32','ptr','ptr'],returns:'bool'},
  WriteFile:{args:['u64','ptr','u32','ptr','ptr'],returns:'bool'}, FlushFileBuffers:{args:['u64'],returns:'bool'},
  MoveFileExW:{args:['ptr','ptr','u32'],returns:'bool'}, DeleteFileW:{args:['ptr'],returns:'bool'},
}).symbols;
const nt=dlopen(path.join(root,'System32/ntdll.dll'),{
  NtQueryInformationProcess:{args:['u64','u32','ptr','u32','ptr'],returns:'i32'},
}).symbols;
const a=dlopen(path.join(root,'System32/advapi32.dll'),{
  OpenProcessToken:{args:['u64','u32','ptr'],returns:'bool'},
  GetTokenInformation:{args:['u64','u32','ptr','u32','ptr'],returns:'bool'},
  ConvertSidToStringSidW:{args:['ptr','ptr'],returns:'bool'},
  ConvertStringSecurityDescriptorToSecurityDescriptorW:{args:['ptr','u32','ptr','ptr'],returns:'bool'},
  ConvertSecurityDescriptorToStringSecurityDescriptorW:{args:['ptr','u32','u32','ptr','ptr'],returns:'bool'},
  GetSecurityInfo:{args:['u64','u32','u32','ptr','ptr','ptr','ptr','ptr'],returns:'u32'},
}).symbols;
const crypt=dlopen(path.join(root,'System32/crypt32.dll'),{
  CryptProtectData:{args:['ptr','ptr','ptr','ptr','ptr','u32','ptr'],returns:'bool'},
  CryptUnprotectData:{args:['ptr','ptr','ptr','ptr','ptr','u32','ptr'],returns:'bool'},
}).symbols;
const INVALID=0xffffffffffffffffn;
const MAX=2*1024*1024;
const deny=()=>Object.assign(new Error('pc_private_storage'),{code:'pc_private_storage'});
const wide=s=>Buffer.from(s+'\0','utf16le');
function address(buffer){const n=Number(buffer.readBigUInt64LE()); if(!Number.isSafeInteger(n)||n<0)throw deny(); return n;}
function text(pointer,max=65536){
  let result=''; for(let i=0;i<max;i++){const n=Buffer.from(toArrayBuffer(pointer+i*2,0,2)).readUInt16LE(); if(!n)return result;result+=String.fromCharCode(n);}throw deny();
}
function checked(ok){if(!ok)throw deny();}
function sidText(sidPointer){const out=Buffer.alloc(8);checked(a.ConvertSidToStringSidW(sidPointer,out));const p=address(out);try{return text(p,256);}finally{k.LocalFree(p);}}
function currentSid(){
  const processHandle=k.OpenProcess(0x1000,false,process.pid);if(!processHandle)throw deny();
  const token=Buffer.alloc(8);let tokenHandle;
  try {
    checked(a.OpenProcessToken(processHandle,8,token));tokenHandle=token.readBigUInt64LE();
    const count=Buffer.alloc(4);a.GetTokenInformation(tokenHandle,1,null,0,count);
    const n=count.readUInt32LE();if(!n||n>65536)throw deny();const info=Buffer.alloc(n);
    checked(a.GetTokenInformation(tokenHandle,1,info,n,count));return sidText(address(info));
  }finally{if(tokenHandle)k.CloseHandle(tokenHandle);k.CloseHandle(processHandle);}
}
const USER_SID=currentSid();
function assertUser(sid){if(sid!==USER_SID)throw deny();}
function validPath(p){
  if(typeof p!=='string'||!path.win32.isAbsolute(p)||p.startsWith('\\\\')||p.includes('\0')||p.length>4096
    ||p.slice(2).includes(':')||p.split(/[\\/]/).some(s=>s==='..'||/[ .]$/.test(s)))throw deny();
  const full=path.win32.resolve(p);if(full.toLowerCase()===path.win32.parse(full).root.toLowerCase())throw deny();return full;
}
function attributes(p){const n=k.GetFileAttributesW(wide(p));if(n===0xffffffff){if([2,3].includes(k.GetLastError()))return undefined;throw deny();}return n;}
function handleKind(h,directory){const b=Buffer.alloc(8);checked(k.GetFileInformationByHandleEx(h,9,b,8));const flags=b.readUInt32LE();if((flags&0x400)||!!(flags&0x10)!==directory)throw deny();}
function open(p,access,share=3,creation=3,security=null){
  const h=k.CreateFileW(wide(p),access>>>0,share,security,creation,0x02200000,null);
  if(h===INVALID||h===0n){const nativeCode=k.GetLastError();throw Object.assign(deny(),{nativeCode});}return h;
}
function fence(parent){
  const paths=[];for(let p=parent;;p=path.win32.dirname(p)){paths.unshift(p);if(path.win32.dirname(p)===p)break;}
  const held=[];
  try{for(const p of paths){const h=open(p,0x20080);held.push(h);handleKind(h,true);}return()=>{for(const h of held.reverse())k.CloseHandle(h);};}
  catch(e){for(const h of held.reverse())k.CloseHandle(h);throw e;}
}
function descriptor(directory){
  const flags=directory?'OICI':'';
  const sddl=`O:${USER_SID}D:P(A;${flags};FA;;;${USER_SID})(A;${flags};FA;;;SY)(A;${flags};FA;;;BA)`;
  const out=Buffer.alloc(8);checked(a.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl),1,out,null));
  const sd=address(out),sa=Buffer.alloc(24);sa.writeUInt32LE(24,0);sa.writeBigUInt64LE(BigInt(sd),8);
  return {sa,dispose:()=>k.LocalFree(sd)};
}
function assertAcl(h,directory){
  handleKind(h,directory);
  const owner=Buffer.alloc(8),sd=Buffer.alloc(8),out=Buffer.alloc(8),length=Buffer.alloc(4);
  if(a.GetSecurityInfo(h,1,5,owner,null,null,null,sd)!==0)throw deny();
  const descriptorPointer=address(sd);let sddlPointer;
  try {
    if(sidText(address(owner))!==USER_SID)throw deny();
    checked(a.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptorPointer,1,4,out,length));
    sddlPointer=address(out);const sddl=text(sddlPointer);
    if(!/^D:P\(/.test(sddl))throw deny();
    const entries=[...sddl.matchAll(/\(([^()]*)\)/g)];const expected=new Set([USER_SID,'SY','BA']);
    if(entries.length!==expected.size)throw deny();
    for(const [,entry] of entries){const [type,flags,rights,guid,inherited,sid]=entry.split(';');
      if(type!=='A'||flags!==(directory?'OICI':'')||rights!=='FA'||guid||inherited||!expected.delete(sid))throw deny();
    }
    if(expected.size)throw deny();
  }finally{if(sddlPointer)k.LocalFree(sddlPointer);k.LocalFree(descriptorPointer);}
}
function assertPrivatePath(p,sid,{directory=false}={}){
  assertUser(sid);p=validPath(p);const release=fence(path.win32.dirname(p));let h;
  try{h=open(p,0x20080);assertAcl(h,directory);}finally{if(h)k.CloseHandle(h);release();}
}
function ensurePrivateDirectory(p,sid){
  assertUser(sid);p=validPath(p);const release=fence(path.win32.dirname(p));let h;
  try{
    const attr=attributes(p);
    if(attr===undefined){const policy=descriptor(true);try{if(!k.CreateDirectoryW(wide(p),policy.sa)&&k.GetLastError()!==183)throw deny();}finally{policy.dispose();}}
    h=open(p,0x20080);assertAcl(h,true);
  }finally{if(h)k.CloseHandle(h);release();}
}
function privateParent(p){const parent=path.win32.dirname(p);const release=fence(parent);let h;
  try{h=open(parent,0x20080);assertAcl(h,true);return()=>{k.CloseHandle(h);release();};}
  catch(e){if(h)k.CloseHandle(h);release();throw e;}
}
function readHandle(h,maxBytes){
  const size=Buffer.alloc(8);checked(k.GetFileSizeEx(h,size));const n=Number(size.readBigInt64LE());
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>MAX||n<0||n>maxBytes)throw deny();
  checked(k.SetFilePointerEx(h,0,null,0));const bytes=Buffer.alloc(n);let offset=0;
  while(offset<n){const count=Buffer.alloc(4);checked(k.ReadFile(h,bytes.subarray(offset),n-offset,count,null));const got=count.readUInt32LE();if(!got)throw deny();offset+=got;}
  return bytes;
}
function writeHandle(h,bytes){
  bytes=Buffer.from(bytes);if(bytes.length>MAX)throw deny();checked(k.SetFilePointerEx(h,0,null,0));
  let offset=0;while(offset<bytes.length){const count=Buffer.alloc(4);checked(k.WriteFile(h,bytes.subarray(offset),bytes.length-offset,count,null));const n=count.readUInt32LE();if(!n)throw deny();offset+=n;}
  checked(k.SetEndOfFile(h));checked(k.FlushFileBuffers(h));
}
function readPrivateFile(p,sid,maxBytes=MAX){
  assertUser(sid);p=validPath(p);const release=privateParent(p);let h;
  try{h=open(p,0x80020080,1);assertAcl(h,false);const bytes=readHandle(h,maxBytes);assertAcl(h,false);return bytes;}
  finally{if(h)k.CloseHandle(h);release();}
}
function writePrivateAtomic(p,bytes,sid){
  assertUser(sid);p=validPath(p);bytes=Buffer.from(bytes);if(bytes.length>MAX)throw deny();const release=privateParent(p);
  const temp=path.win32.join(path.win32.dirname(p),`.pc-private-${randomUUID()}.tmp`);let h,created=false;
  try{
    if(attributes(p)!==undefined){h=open(p,0x20080);assertAcl(h,false);k.CloseHandle(h);h=null;}
    const policy=descriptor(false);
    try{h=open(temp,0x40020080,0,1,policy.sa);created=true;}finally{policy.dispose();}
    assertAcl(h,false);writeHandle(h,bytes);k.CloseHandle(h);h=null;
    checked(k.MoveFileExW(wide(temp),wide(p),9));created=false;
    h=open(p,0x20080);assertAcl(h,false);
  }finally{if(h)k.CloseHandle(h);if(created)k.DeleteFileW(wide(temp));release();}
}
function removePrivateFile(p,sid){
  assertUser(sid);p=validPath(p);const release=privateParent(p);let h;
  try{if(attributes(p)===undefined)return;h=open(p,0x20080);assertAcl(h,false);k.CloseHandle(h);h=null;checked(k.DeleteFileW(wide(p)));}
  finally{if(h)k.CloseHandle(h);release();}
}
function quarantinePrivateFile(p,sid){
  assertUser(sid);p=validPath(p);const release=privateParent(p);let h;
  try{h=open(p,0x20080);assertAcl(h,false);k.CloseHandle(h);h=null;const target=p+'.quarantine-'+randomUUID();checked(k.MoveFileExW(wide(p),wide(target),8));return target;}
  finally{if(h)k.CloseHandle(h);release();}
}
function acquireExclusivePrivateFile(p,sid){
  assertUser(sid);p=validPath(p);const release=privateParent(p);let h,closed=false;
  try{
    if(attributes(p)===undefined){const policy=descriptor(false);try{h=open(p,0xc0020080,0,1,policy.sa);}finally{policy.dispose();}}
    else h=open(p,0xc0020080,0);
    assertAcl(h,false);
    return {readBytes:n=>{if(closed)throw deny();return readHandle(h,n);},writeBytes:b=>{if(closed)throw deny();writeHandle(h,b);},close(){if(closed)return;closed=true;k.CloseHandle(h);release();}};
  }catch(e){if(h)k.CloseHandle(h);release();if([32,33,80,183].includes(e.nativeCode))throw Object.assign(new Error('pc_resource_busy'),{code:'pc_resource_busy'});throw e;}
}
function dpapi(bytes,profileId,protect){
  if(!['pc2-normal','pc2-dev'].includes(profileId))throw deny();
  bytes=Buffer.from(bytes);if(bytes.length>MAX)throw deny();
  const entropy=Buffer.from('Feno PC2 protected selection v2:'+profileId,'utf8');
  function blob(buffer){const out=Buffer.alloc(16);out.writeUInt32LE(buffer.length);out.writeBigUInt64LE(BigInt(ptr(buffer)),8);return out;}
  const input=blob(bytes),context=blob(entropy),output=Buffer.alloc(16);
  // CRYPTPROTECT_UI_FORBIDDEN only; deliberately no CRYPTPROTECT_LOCAL_MACHINE.
  checked((protect?crypt.CryptProtectData:crypt.CryptUnprotectData)(input,null,context,null,null,1,output));
  const p=address(output.subarray(8));
  // toArrayBuffer is a view into LocalAlloc memory. Copy before LocalFree.
  try{const size=output.readUInt32LE();if(size>MAX)throw deny();return Buffer.from(new Uint8Array(toArrayBuffer(p,0,size)));}
  finally{if(p)k.LocalFree(p);}
}
function inspectProcess(pid){
  if(!Number.isInteger(pid)||pid<1||pid>0xffffffff)throw deny();
  const h=k.OpenProcess(0x101000,false,pid);
  if(!h){const error=k.GetLastError();return {state:error===87?'dead':'unknown',pid};}
  try{
    const created=Buffer.alloc(8),exited=Buffer.alloc(8),kernel=Buffer.alloc(8),user=Buffer.alloc(8);
    if(!k.GetProcessTimes(h,created,exited,kernel,user))return {state:'unknown',pid};
    const wait=k.WaitForSingleObject(h,0);
    return {state:wait===0?'dead':wait===258?'alive':'unknown',pid,startTime:created.readBigUInt64LE().toString()};
  }finally{k.CloseHandle(h);}
}
/** All bridge launcher main processes, including a DEV whose profile home vanished.
 * A failed native snapshot or unreadable candidate command line is UNKNOWN, never ABSENT. */
function inspectDevLauncherProcesses(){
  const snapshot=k.CreateToolhelp32Snapshot(2,0);
  if(!snapshot||snapshot===INVALID)return {state:'unknown',pids:[]};
  const entry=Buffer.alloc(568);entry.writeUInt32LE(entry.length);
  let possibleUnknown=false;const devPids=[];
  try{
    if(!k.Process32FirstW(snapshot,entry))return {state:'unknown',pids:[]};
    do{
      const name=entry.subarray(44,564).toString('utf16le').split('\0')[0].toLowerCase();
      if(!['feno bridge.exe','feno-bridge.exe','feno bridge dev.exe','electron.exe'].includes(name))continue;
      const pid=entry.readUInt32LE(8);const state=inspectProcess(pid);
      if(state.state==='dead')continue;
      if(state.state!=='alive'){possibleUnknown=true;continue;}
      const handle=k.OpenProcess(0x1000,false,pid);
      if(!handle){possibleUnknown=true;continue;}
      try{
        const bytes=Buffer.alloc(65536),returned=Buffer.alloc(4);
        // ProcessCommandLineInformation (60), available since Windows 8.1.
        const status=nt.NtQueryInformationProcess(handle,60,bytes,bytes.length,returned);
        if(status!==0){possibleUnknown=true;continue;}
        const count=bytes.readUInt16LE(0),pointer=Number(bytes.readBigUInt64LE(8));
        const base=Number(ptr(bytes));
        if(!count||count>32768||count%2||!Number.isSafeInteger(pointer)||!Number.isSafeInteger(base)
          ||pointer<base||pointer+count>base+bytes.length){possibleUnknown=true;continue;}
        const command=bytes.subarray(pointer-base,pointer-base+count).toString('utf16le');
        const after=inspectProcess(pid);
        if(after.state!=='alive'||after.startTime!==state.startTime){possibleUnknown=true;continue;}
        if(/(?:^|\s)--dev-profile(?:\s|$)/i.test(command))devPids.push(pid);
      }catch{possibleUnknown=true;}
      finally{k.CloseHandle(handle);}
    }while(k.Process32NextW(snapshot,entry));
    return {state:devPids.length?'alive':possibleUnknown?'unknown':'absent',pids:devPids};
  }finally{k.CloseHandle(snapshot);}
}
function handleRequest(req){
  if(!req||typeof req!=='object')throw deny();const p=req.path,sid=req.userSid;
  if(req.action==='context')return {ok:true,userSid:USER_SID,process:inspectProcess(req.pid)};
  if(req.action==='inspect-process'){assertUser(sid);return {ok:true,process:inspectProcess(req.pid)};}
  if(req.action==='inspect-dev-launchers'){assertUser(sid);return {ok:true,state:inspectDevLauncherProcesses()};}
  if(['protect','unprotect','protection-check'].includes(req.action)){
    assertUser(sid);
    if(req.action==='protection-check'){
      const fixture=Buffer.from('pc-storage-protection-check');
      if(!dpapi(dpapi(fixture,req.profileId,true),req.profileId,false).equals(fixture))throw deny();return {ok:true};
    }
    return {ok:true,data:dpapi(Buffer.from(req.data,'base64'),req.profileId,req.action==='protect').toString('base64')};
  }
  if(req.action==='ensure')ensurePrivateDirectory(p,sid);
  else if(req.action==='assert')assertPrivatePath(p,sid,{directory:req.directory===true});
  else if(req.action==='write')writePrivateAtomic(p,Buffer.from(req.data,'base64'),sid);
  else if(req.action==='read')return {ok:true,data:readPrivateFile(p,sid,req.maxBytes).toString('base64')};
  else if(req.action==='remove')removePrivateFile(p,sid);
  else if(req.action==='quarantine')return {ok:true,path:quarantinePrivateFile(p,sid)};
  else throw deny();return {ok:true};
}
module.exports={getCurrentUserSid:()=>USER_SID,inspectProcess,inspectDevLauncherProcesses,ensurePrivateDirectory,assertPrivatePath,readPrivateFile,writePrivateAtomic,removePrivateFile,quarantinePrivateFile,acquireExclusivePrivateFile,handleRequest};
