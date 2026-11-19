"use strict";

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync,spawn } = require('node:child_process');
const {resolveElectronHelper,resolveRuntimeHelper}=require('./private-acl-location.cjs');

const MAX_BYTES = 2 * 1024 * 1024;
const deny = () => Object.assign(new Error('pc_private_storage'), {code:'pc_private_storage'});
const transient=code=>Object.assign(new Error('pc_private_storage_transient'),{code:'pc_private_storage_transient',nativeCode:code});
// The bundle pins the helper digests; source Bun execution keeps its in-process
// native module. Do not use lexical __dirname in code bundled by Bun.
const packagedPins=typeof __FENO_PACKAGED_ACL_HASHES__==='undefined'?null:__FENO_PACKAGED_ACL_HASHES__;
function helperCommand(options){
  try{
    if(process.versions.bun&&packagedPins){
      return {executable:process.execPath,helper:resolveRuntimeHelper(process.argv[1],process.execPath,packagedPins)};
    }
    const executable=options.bunPath;
    if(typeof executable!=='string'||!path.isAbsolute(executable)||!fs.statSync(executable).isFile())throw deny();
    return {executable,helper:resolveElectronHelper(module.filename)};
  }catch{throw deny();}
}
function native(request,options={}) {
  try{return nativeImpl(request,options);}catch(error){error.op=request.action;throw error;}
}
function nativeImpl(request,options={}) {
  if(process.platform !== 'win32') throw deny();
  if(process.versions.bun&&!packagedPins)return require('./private-acl-native.cjs').handleRequest(request);
  // Supplied by the trusted launcher from its verified embedded runtime, never MCP arguments or PATH.
  const {executable,helper}=helperCommand(options);
  const result=spawnSync(executable,[helper],{
    input:JSON.stringify(request),encoding:'utf8',windowsHide:true,shell:false,timeout:3000,maxBuffer:4*1024*1024,
  });
  return parseNativeResult(result);
}
// Pure translation of the verified helper's result; independent of host OS.
function parseNativeResult(result){
  if(result.error){
    if(['ETIMEDOUT','EBUSY','EAGAIN','EACCES','EPERM'].includes(result.error.code))throw transient(result.error.code);
    throw deny();
  }
  if(result.status!==0){
    let failure;try{failure=JSON.parse(result.stdout);}catch{}
    if(failure?.code==='pc_private_storage_transient'&&[5,32,33].includes(failure.nativeCode))throw transient(failure.nativeCode);
    throw deny();
  }
  let value; try { value=JSON.parse(result.stdout); } catch { throw deny(); }
  if(value?.ok !== true) throw deny();
  return value;
}
// Periodic launcher work uses the same verified Bun helper without blocking
// Electron's main event loop while Windows waits on an ACL or file lock.
async function nativeAsync(request,options={}){
  try{return await nativeAsyncImpl(request,options);}catch(error){error.op=request.action;throw error;}
}
async function nativeAsyncImpl(request,options={}){
  if(process.platform!=='win32')throw deny();
  if(process.versions.bun&&!packagedPins)return require('./private-acl-native.cjs').handleRequest(request);
  const {executable,helper}=helperCommand(options);
  return new Promise((resolve,reject)=>{
    let finished=false,output='',size=0;
    const child=spawn(executable,[helper],{windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});
    const fail=error=>{if(finished)return;finished=true;clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>{child.kill();fail(transient('ETIMEDOUT'));},3000);
    child.on('error',error=>fail(['ETIMEDOUT','EBUSY','EAGAIN','EACCES','EPERM'].includes(error.code)?transient(error.code):deny()));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024){child.kill();fail(deny());}else output+=chunk.toString('utf8');});
    child.on('close',code=>{
      if(finished)return;
      let value;try{value=JSON.parse(output);}catch{fail(deny());return;}
      if(code!==0){fail(value?.code==='pc_private_storage_transient'&&[5,32,33].includes(value.nativeCode)?transient(value.nativeCode):deny());return;}
      if(value?.ok!==true){fail(deny());return;}
      finished=true;clearTimeout(timer);resolve(value);
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(request));
  });
}
function request(action,filePath,userSid,extra={},options={}) {
  if(typeof filePath !== 'string' || !path.win32.isAbsolute(filePath) || typeof userSid !== 'string') throw deny();
  return native({action,path:filePath,userSid,...extra},options);
}
function ensurePrivateDirectory(directory,userSid,options) { request('ensure',directory,userSid,{},options); }
function assertPrivatePath(filePath,userSid,{directory=false,...options}={}) { request('assert',filePath,userSid,{directory},options); }
function writePrivateAtomic(filePath,bytes,userSid,options) {
  if(typeof bytes !== 'string' && !Buffer.isBuffer(bytes)) throw deny();
  const data=Buffer.from(bytes); if(data.length > MAX_BYTES) throw deny();
  request('write',filePath,userSid,{data:data.toString('base64')},options);
}
function readPrivateFile(filePath,userSid,maxBytes=MAX_BYTES,options) {
  if(!Number.isSafeInteger(maxBytes) || maxBytes<0 || maxBytes>MAX_BYTES) throw deny();
  const value=request('read',filePath,userSid,{maxBytes},options);
  if(typeof value.data !== 'string') throw deny();
  const bytes=Buffer.from(value.data,'base64'); if(bytes.length>maxBytes) throw deny(); return bytes;
}
function removePrivateFile(filePath,userSid,options) { request('remove',filePath,userSid,{},options); }
function quarantinePrivateFile(filePath,userSid,options) { return request('quarantine',filePath,userSid,{},options).path; }
function createPrivateFileAccess(userSid,options={}) {
  options=Object.freeze({...options});
  return Object.freeze({
    ensurePrivateDirectory:p=>ensurePrivateDirectory(p,userSid,options),
    assertPrivatePath:(p,o)=>assertPrivatePath(p,userSid,{...o,...options}),
    writePrivateAtomic:(p,b)=>writePrivateAtomic(p,b,userSid,options),
    readPrivateFile:(p,n)=>readPrivateFile(p,userSid,n,options),
    readPrivateFileAsync:async(p,n)=>{
      if(!Number.isSafeInteger(n)||n<0||n>MAX_BYTES)throw deny();
      const value=await nativeAsync({action:'read',path:p,userSid,maxBytes:n},options);
      const bytes=Buffer.from(value.data,'base64');if(bytes.length>n)throw deny();return bytes;
    },
    writePrivateAtomicAsync:async(p,b)=>{
      const bytes=Buffer.from(b);if(bytes.length>MAX_BYTES)throw deny();
      await nativeAsync({action:'write',path:p,userSid,data:bytes.toString('base64')},options);
    },
    ensurePrivateDirectoryAsync:async p=>{await nativeAsync({action:'ensure',path:p,userSid},options);},
    removePrivateFile:p=>removePrivateFile(p,userSid,options),
    cleanupPrivateTemps:p=>request('cleanup-temps',p,userSid,{},options).removed,
    quarantinePrivateFile:p=>quarantinePrivateFile(p,userSid,options),
    inspectProcess:pid=>native({action:'inspect-process',userSid,pid},options).process,
    inspectDevLauncherProcesses:()=>native({action:'inspect-dev-launchers',userSid},options).state,
  });
}
function getNativeSecurityContext(options={}){return native({action:'context',pid:process.pid},options);}
function createWindowsDpapiProtection(userSid,profileId,options={}) {
  require('./pc-profile-policy.cjs').assertPcProfileId(profileId);
  const transform=(action,bytes)=>Buffer.from(native({action,userSid,profileId,data:Buffer.from(bytes).toString('base64')},options).data,'base64');
  return Object.freeze({
    isEncryptionAvailable(){try{native({action:'protection-check',userSid,profileId},options);return true;}catch{return false;}},
    async isEncryptionAvailableAsync(){try{await nativeAsync({action:'protection-check',userSid,profileId},options);return true;}catch(error){if(error?.code==='pc_private_storage_transient')throw error;return false;}},
    encryptString:text=>transform('protect',Buffer.from(text,'utf8')),
    encryptStringAsync:async text=>Buffer.from((await nativeAsync({action:'protect',userSid,profileId,data:Buffer.from(text,'utf8').toString('base64')},options)).data,'base64'),
    decryptString:bytes=>transform('unprotect',bytes).toString('utf8'),
  });
}
module.exports={getNativeSecurityContext,ensurePrivateDirectory,assertPrivatePath,writePrivateAtomic,readPrivateFile,
  removePrivateFile,quarantinePrivateFile,createPrivateFileAccess,createWindowsDpapiProtection,parseNativeResult};
