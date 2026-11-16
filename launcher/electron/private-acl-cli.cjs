"use strict";
const fs=require('node:fs');
try{
  const input=fs.readFileSync(0,'utf8');if(input.length>3000000)throw new Error();
  const result=require('./private-acl-native.cjs').handleRequest(JSON.parse(input));
  process.stdout.write(JSON.stringify(result));
}catch(error){
  // Transient native sharing/rename errors are safe to disclose numerically.
  if([5,32,33].includes(error?.nativeCode))process.stdout.write(JSON.stringify({ok:false,code:'pc_private_storage_transient',nativeCode:error.nativeCode}));
  else process.stderr.write('pc_private_storage');
  process.exitCode=1;
}
