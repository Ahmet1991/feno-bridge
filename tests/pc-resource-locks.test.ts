import {test,expect} from 'bun:test';
import {mkdtempSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {assertCompatiblePcResourcePeers} from '../src/pc-control/resource-protocol';
import {acquirePcHostLease,recoverPcHostResource} from '../src/pc-control/resource-locks';
const getCurrentUserSid=()=>require('../launcher/electron/private-acl-native.cjs').getCurrentUserSid();
const windowsTest=process.platform==='win32'?test:test.skip;
const peers={complete:true,peers:[{profileId:'pc2-normal',verified:true,state:'active',protocol:'pc-host-control-v1'},{profileId:'pc2-dev',verified:true,state:'inactive'}]};
function context(){const directory=join(mkdtempSync(join(tmpdir(),'pc-resource-unit-')),'private');const authorizer=new PcAuthorizer({profileId:'pc2-normal'});return {directory,userSid:getCurrentUserSid(),profileId:'pc2-normal' as const,authorizer,operation:'job' as const,operationId:'operation-fixture-01',observePeers:()=>peers};}
function approve(authorizer:PcAuthorizer,id='resource-grant-0001'){authorizer.setGrantFromLocalApproval({profileId:'pc2-normal',id,expiresAt:Date.now()+60000,roots:[],permissions:['jobs'],allowedApps:[]});}
test('unknown, incomplete and legacy peer evidence never enables coordinated operations',()=>{
  expect(()=>assertCompatiblePcResourcePeers(undefined)).toThrow('pc_resource_coordination_required');
  expect(()=>assertCompatiblePcResourcePeers({...peers,complete:false})).toThrow();
  expect(()=>assertCompatiblePcResourcePeers({complete:true,peers:[]})).toThrow();
  expect(()=>assertCompatiblePcResourcePeers({complete:true,peers:[peers.peers[0],{profileId:'pc2-dev',verified:true,state:'active',protocol:'legacy'}]})).toThrow();
  expect(()=>assertCompatiblePcResourcePeers(peers)).not.toThrow();
});
windowsTest('a resource lock cannot supply permission or borrow another profile grant',async()=>{
  const c=context();await expect(acquirePcHostLease(c)).rejects.toThrow('pc_access_denied');expect(existsSync(c.directory)).toBe(false);
  approve(c.authorizer);await expect(acquirePcHostLease({...c,profileId:'pc2-dev'})).rejects.toThrow('pc_access_denied');
});
windowsTest('release waits for real completion, is idempotent, and a rejected observation retains ownership',async()=>{
  const c=context();approve(c.authorizer);const lease=await acquirePcHostLease(c);
  await expect(lease.releaseAfterExit(Promise.reject(Error('unknown exit')))).rejects.toThrow('unknown exit');
  await expect(acquirePcHostLease({...c,operationId:'operation-fixture-02'})).rejects.toThrow('pc_resource_busy');
  let finished!:()=>void;const release=lease.releaseAfterExit(new Promise<void>(r=>finished=r));
  expect(lease.releaseAfterExit(Promise.resolve())).toBe(release);
  await expect(acquirePcHostLease({...c,operationId:'operation-fixture-03'})).rejects.toThrow('pc_resource_busy');
  finished();await release;await lease.releaseAfterExit(Promise.resolve());
  const next=await acquirePcHostLease({...c,operationId:'operation-fixture-04'});await next.releaseAfterExit(Promise.resolve());
});
windowsTest('wait cancellation, bounded timeout and grant revocation never steal the active lease',async()=>{
  const c=context();approve(c.authorizer);const lease=await acquirePcHostLease(c);
  await expect(acquirePcHostLease({...c,timeoutMs:30})).rejects.toThrow('pc_resource_timeout');
  const cancel=new AbortController();const waiting=acquirePcHostLease({...c,timeoutMs:1000,signal:cancel.signal});cancel.abort();
  await expect(waiting).rejects.toThrow('pc_resource_cancelled');
  const waiting2=acquirePcHostLease({...c,timeoutMs:1000});c.authorizer.revoke();
  await expect(waiting2).rejects.toThrow('pc_access_denied');
  await lease.releaseAfterExit(Promise.resolve());
});
windowsTest('local recovery cannot clear a live owner or another profile and requires confirmation',async()=>{
  const c=context();approve(c.authorizer);const lease=await acquirePcHostLease(c);
  await expect(recoverPcHostResource({...c,expectedGeneration:lease.generation,confirmLocally:async()=>true,exitProof:Promise.resolve()})).rejects.toThrow('pc_resource_busy');
  await lease.releaseAfterExit(Promise.resolve());
});

windowsTest('an elapsed waiting deadline cannot acquire a newly freed resource',async()=>{
  const c=context();approve(c.authorizer);const lease=await acquirePcHostLease(c);
  const waiting=acquirePcHostLease({...c,timeoutMs:10});
  await lease.releaseAfterExit(Promise.resolve());
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40);
  await expect(waiting).rejects.toThrow('pc_resource_timeout');
});
