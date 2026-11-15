"use strict";
const path=require('node:path');
const {assertPcProfileId,validatePcSelection,copyPcSelection}=require('./pc-profile-policy.cjs');
const MAX_BYTES=16384,deny=()=>new Error('pc_access_denied');
function createPcPersistentConsent({filePath,profileId,encryption,files,allowLegacyDevSelection=false}){
  assertPcProfileId(profileId);
  if(!path.isAbsolute(filePath)||!files?.readPrivateFile||!files?.writePrivateAtomic||!files?.quarantinePrivateFile
    ||(allowLegacyDevSelection&&profileId!=='pc2-dev')||typeof encryption?.encryptString!=='function'||typeof encryption?.decryptString!=='function'||typeof encryption?.isEncryptionAvailable!=='function')throw deny();
  let receipts=new WeakSet(),suppressRestore=false;
  const available=()=>{try{return process.platform==='win32'&&encryption.isEncryptionAvailable()===true;}catch{return false;}};
  const persist=value=>{
    if(!available())throw deny();
    const bytes=encryption.encryptString(JSON.stringify(value));
    if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX_BYTES)throw deny();
    files.ensurePrivateDirectory(path.dirname(filePath));files.writePrivateAtomic(filePath,bytes);
  };
  return Object.freeze({profileId,isProtectionAvailable:available,
    save(selection){
      receipts=new WeakSet();suppressRestore=true;
      if(!available())throw deny();validatePcSelection(selection);if(selection.durationMs!==null)throw deny();
      const text=JSON.stringify({schema:2,profileId,selection:copyPcSelection(selection)});if(Buffer.byteLength(text)>MAX_BYTES)throw deny();
      persist(JSON.parse(text));suppressRestore=false;
    },
    restore(){
      if(suppressRestore||!available())return null;
      let bytes;try{bytes=files.readPrivateFile(filePath,MAX_BYTES);}catch{return null;}
      try{
        const text=encryption.decryptString(bytes);if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw deny();
        const value=JSON.parse(text);
        if(value.schema===2&&value.profileId!==profileId)return null;
        if(value.schema===2&&value.revoked===true)return null;
        if(value.schema===1&&(!allowLegacyDevSelection||profileId!=='pc2-dev'))return null;
        if(value.schema!==2&&value.schema!==1)throw deny();
        validatePcSelection(value.selection);if(value.selection.durationMs!==null||(value.selection.fullAccess&&profileId!=='pc2-normal'))throw deny();
        const selection=copyPcSelection(value.selection);Object.freeze(selection.roots);Object.freeze(selection.permissions);Object.freeze(selection.allowedApps);Object.freeze(selection);
        receipts.add(selection);return selection;
      }catch{try{files.quarantinePrivateFile(filePath);}catch{}return null;}
    },
    isTrustedSelection(selection){return !!selection&&receipts.has(selection);},
    // Keep a durable encrypted denial rather than depending on deletion succeeding.
    clear(){receipts=new WeakSet();suppressRestore=true;persist({schema:2,profileId,revoked:true});},
  });
}
module.exports={createPcPersistentConsent};
