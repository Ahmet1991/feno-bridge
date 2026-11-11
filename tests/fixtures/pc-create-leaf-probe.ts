import { mock } from 'bun:test';
import * as promises from 'node:fs/promises';
import { mkdtempSync,mkdirSync,renameSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const original = promises.open;
const root = mkdtempSync(join(tmpdir(),'pc-leaf-probe-'));
const approved=join(root,'approved'),outside=join(root,'outside');
mkdirSync(approved);mkdirSync(outside);
const target=join(approved,'new.txt'), moved=join(outside,'moved.txt');
const duringWrite=process.argv[2]==='during-write';
let renameBlocked=false;
mock.module('node:fs/promises',()=>({...promises,open:async (...args: Parameters<typeof original>)=>{
  const handle=await original(...args);
  return {
    stat: async()=>{ const identity=await handle.stat();if(!duringWrite){renameSync(target,moved);writeFileSync(target,'replacement');}return identity; },
    writeFile:async (...input: Parameters<typeof handle.writeFile>)=>{
      if(duringWrite){try{renameSync(target,moved);writeFileSync(target,'replacement');}catch{renameBlocked=true;}}
      return handle.writeFile(...input);
    },sync:handle.sync.bind(handle),close:handle.close.bind(handle),
  };
}}));
try {
  const {PcAuthorizer}=await import('../../src/pc-control/authorization');
  const {createPcFile}=await import('../../src/pc-control/files');
  const policy=new PcAuthorizer();
  policy.setGrantFromLocalApproval({id:'local-leaf-race-probe',expiresAt:null,roots:[approved],permissions:['files.write'],allowedApps:[]});
  let denied=false;
  await createPcFile(target,'fixture-payload',policy).catch(()=>{denied=true;});
  console.log(JSON.stringify({denied,...(duringWrite?{renameBlocked}:{}),outsideContent:existsSync(moved)?readFileSync(moved,'utf8'):null,insideContent:readFileSync(target,'utf8')}));
}finally{mock.restore();rmSync(root,{recursive:true,force:true});}
