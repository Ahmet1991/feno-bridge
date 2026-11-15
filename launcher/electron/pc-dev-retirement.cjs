"use strict";
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const deny=()=>new Error('pc_access_denied');
/** Normal-profile-only encrypted decision. Never exposed to MCP as a mutation. */
function createPcDevRetirementStore({directory,files,encryption}){
  if(!path.isAbsolute(directory)||!files?.readPrivateFile||!files?.writePrivateAtomic
    ||typeof encryption?.encryptString!=='function'||typeof encryption?.decryptString!=='function'
    ||encryption?.isEncryptionAvailable?.()!==true)throw deny();
  const file=path.join(directory,'pc2-normal-dev-retirement.enc');
  return Object.freeze({
    read(){
      try{
        const cipher=files.readPrivateFile(file,8192);
        const text=encryption.decryptString(cipher);
        if(typeof text!=='string'||Buffer.byteLength(text)>4096)throw deny();
        const record=JSON.parse(text);
        return record?.schema===1&&record.profileId==='pc2-normal'&&record.purpose==='dev-retirement'
          &&typeof record.nonce==='string'&&/^[a-f0-9-]{36}$/.test(record.nonce)
          &&typeof record.retired==='boolean'?record.retired:false;
      }catch{return false;}
    },
    set(retired){
      if(typeof retired!=='boolean')throw deny();
      const record={schema:1,profileId:'pc2-normal',purpose:'dev-retirement',retired,nonce:randomUUID()};
      const bytes=encryption.encryptString(JSON.stringify(record));
      if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>8192)throw deny();
      files.writePrivateAtomic(file,bytes);
      if(this.read()!==retired)throw deny();
    },
  });
}
module.exports={createPcDevRetirementStore};
