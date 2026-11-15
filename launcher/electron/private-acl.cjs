"use strict";

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_BYTES = 2 * 1024 * 1024;
const deny = () => Object.assign(new Error('pc_private_storage'), {code:'pc_private_storage'});
const transient=code=>Object.assign(new Error('pc_private_storage_transient'),{code:'pc_private_storage_transient',nativeCode:code});
function native(request,options={}) {
  if(process.platform !== 'win32') throw deny();
  if(process.versions.bun)return require('./private-acl-native.cjs').handleRequest(request);
  // Supplied by the trusted launcher from its verified embedded runtime, never MCP arguments or PATH.
  const executable=options.bunPath;
  try{if(typeof executable!=='string'||!path.isAbsolute(executable)||!fs.statSync(executable).isFile())throw deny();}catch{throw deny();}
  const helper=path.join(__dirname,'private-acl-cli.cjs').replace(/app\.asar([\\/])/,'app.asar.unpacked$1');
  const result=spawnSync(executable,[helper],{
    input:JSON.stringify(request),encoding:'utf8',windowsHide:true,shell:false,timeout:3000,maxBuffer:4*1024*1024,
  });
  if(result.error){
    if(['ETIMEDOUT','EBUSY','EAGAIN'].includes(result.error.code))throw transient(result.error.code);
    throw deny();
  }
  if(result.status!==0){
    let failure;try{failure=JSON.parse(result.stdout);}catch{}
    if(failure?.code==='pc_private_storage_transient'&&[32,33].includes(failure.nativeCode))throw transient(failure.nativeCode);
    throw deny();
  }
  let value; try { value=JSON.parse(result.stdout); } catch { throw deny(); }
  if(value?.ok !== true) throw deny();
  return value;
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
    removePrivateFile:p=>removePrivateFile(p,userSid,options),
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
    encryptString:text=>transform('protect',Buffer.from(text,'utf8')),
    decryptString:bytes=>transform('unprotect',bytes).toString('utf8'),
  });
}
module.exports={getNativeSecurityContext,ensurePrivateDirectory,assertPrivatePath,writePrivateAtomic,readPrivateFile,
  removePrivateFile,quarantinePrivateFile,createPrivateFileAccess,createWindowsDpapiProtection};
