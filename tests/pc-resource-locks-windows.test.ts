import {test,expect} from 'bun:test';
import {mkdtempSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {acquirePcHostLease,recoverPcHostResource} from '../src/pc-control/resource-locks';
const native=process.platform==='win32'?require('../launcher/electron/private-acl-native.cjs'):undefined;
const windowsTest=process.platform==='win32'?test:test.skip;
async function readLine(stream:ReadableStream<Uint8Array>){const reader=stream.getReader();try{const value=await reader.read();if(value.done)throw Error('worker ended');return JSON.parse(new TextDecoder().decode(value.value).trim());}finally{reader.releaseLock();}}
function start(directory:string,profileId:string){return Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/pc-security-lock-worker.ts'),JSON.stringify({directory,profileId})],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});}
windowsTest('two actual Windows processes racing across profiles have exactly one lease owner',async()=>{
  const directory=join(mkdtempSync(join(tmpdir(),'pc-resource-race-')),'private');native.ensurePrivateDirectory(directory,native.getCurrentUserSid());
  const a=start(directory,'pc2-normal'),b=start(directory,'pc2-dev');
  try{
    await Promise.all([readLine(a.stdout),readLine(b.stdout)]);a.stdin.write('start\n');b.stdin.write('start\n');
    const states=await Promise.all([readLine(a.stdout),readLine(b.stdout)]);
    expect(states.filter(s=>s.state==='held')).toHaveLength(1);expect(states.filter(s=>s.error==='pc_resource_busy')).toHaveLength(1);
    const winner=states[0].state==='held'?a:b;winner.stdin.write('release\n');expect((await readLine(winner.stdout)).state).toBe('released');
    await Promise.all([a.exited,b.exited]);
  }finally{a.kill();b.kill();}
},15000);
windowsTest('crash releases the OS handle but requires same-profile local recovery of the ownership journal',async()=>{
  const directory=join(mkdtempSync(join(tmpdir(),'pc-resource-crash-')),'private');const child=start(directory,'pc2-normal');
  try{
    await readLine(child.stdout);child.stdin.write('start\n');const held=await readLine(child.stdout);expect(held.state).toBe('held');
    child.stdin.write('crash\n');expect(await child.exited).toBe(17);
    const authorizer=new PcAuthorizer({profileId:'pc2-normal'});authorizer.setGrantFromLocalApproval({profileId:'pc2-normal',id:'parent-grant-0001',expiresAt:Date.now()+60000,roots:[],permissions:['jobs'],allowedApps:[]});
    const options={directory,userSid:native.getCurrentUserSid(),profileId:'pc2-normal' as const,authorizer,operation:'job' as const,operationId:'parent-operation-01',observePeers:()=>({complete:true,peers:[{profileId:'pc2-normal',verified:true,state:'active',protocol:'pc-host-control-v1'},{profileId:'pc2-dev',verified:true,state:'inactive'}]})};
    await expect(acquirePcHostLease(options)).rejects.toThrow('pc_resource_recovery_required');
    await expect(recoverPcHostResource({...options,profileId:'pc2-dev',expectedGeneration:held.generation,confirmLocally:async()=>true,exitProof:Promise.resolve()})).rejects.toThrow('pc_access_denied');
    await expect(recoverPcHostResource({...options,expectedGeneration:'stale-generation',confirmLocally:async()=>true,exitProof:Promise.resolve()})).rejects.toThrow('pc_resource_recovery_required');
    await expect(recoverPcHostResource({...options,expectedGeneration:held.generation,confirmLocally:async()=>false,exitProof:Promise.resolve()})).rejects.toThrow('pc_access_denied');
    const recordPath=join(directory,'pc-host-control-v1.lock');
    const record=JSON.parse(native.readPrivateFile(recordPath,native.getCurrentUserSid(),8192));
    const self=native.inspectProcess(process.pid);record.owner.pid=process.pid;record.owner.startTime=self.startTime;
    native.writePrivateAtomic(recordPath,JSON.stringify(record),native.getCurrentUserSid());
    await expect(recoverPcHostResource({...options,expectedGeneration:held.generation,confirmLocally:async()=>true,exitProof:Promise.resolve()})).rejects.toThrow('pc_resource_recovery_required');
    // A live PID with a different creation time is a reused identifier, not the old owner.
    record.owner.startTime='1';native.writePrivateAtomic(recordPath,JSON.stringify(record),native.getCurrentUserSid());
    await recoverPcHostResource({...options,expectedGeneration:held.generation,confirmLocally:async()=>true,exitProof:Promise.resolve()});
    const lease=await acquirePcHostLease(options);await lease.releaseAfterExit(Promise.resolve());
  }finally{child.kill();}
},15000);
