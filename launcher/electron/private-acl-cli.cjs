"use strict";
const fs=require('node:fs');
try{
  const input=fs.readFileSync(0,'utf8');if(input.length>3000000)throw new Error();
  const result=require('./private-acl-native.cjs').handleRequest(JSON.parse(input));
  process.stdout.write(JSON.stringify(result));
}catch{process.stderr.write('pc_private_storage');process.exitCode=1;}
