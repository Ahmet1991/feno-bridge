import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PcAuthorizer } from '../src/pc-control/authorization';
import { createPcPolicySync } from '../src/pc-control/consent-sync';
const {createPrivateFileAccess}=require('../launcher/electron/private-acl.cjs');
const {createPcConsentChannel}=require('../launcher/electron/pc-consent-channel.cjs');
const files=process.platform==='win32'?createPrivateFileAccess(require('../launcher/electron/private-acl-native.cjs').getCurrentUserSid()):undefined;
const windowsTest=process.platform==='win32'?test:test.skip;
const enabledGrant=(expiresAt:number|null=61000)=>({profileId:'pc2-normal',id:'signed-fixture-0001',expiresAt,roots:['D:\\GitHub\\fixture'],permissions:['files.read'],allowedApps:[]});

windowsTest('signed private state authorizes only its own profile and tampering revokes',()=>{
  let now=1000;const directory=join(mkdtempSync(join(tmpdir(),'pc-signed-security-')),'private');
  const writer=createPcConsentChannel({directory,profileId:'pc2-normal',files,clock:()=>now});writer.start();writer.activate(enabledGrant());
  const normal=new PcAuthorizer({profileId:'pc2-normal',clock:()=>now});
  const dev=new PcAuthorizer({profileId:'pc2-dev',clock:()=>now});
  const sync=createPcPolicySync({directory,authorizer:normal,files,clock:()=>now});
  sync.refresh();expect(normal.assert('files.read').profileId).toBe('pc2-normal');
  createPcPolicySync({directory,authorizer:dev,files,clock:()=>now}).refresh();expect(dev.status().enabled).toBe(false);
  const state=join(directory,'pc-consent-state.json');const envelope=JSON.parse(files.readPrivateFile(state,32768));
  envelope.payload.grant.permissions.push('terminal.exec');files.writePrivateAtomic(state,JSON.stringify(envelope));
  sync.refresh();expect(normal.status().enabled).toBe(false);
});
windowsTest('revocation is irreversible by replaying an earlier signed grant and cleanup errors cannot preserve access',()=>{
  const directory=join(mkdtempSync(join(tmpdir(),'pc-replay-security-')),'private');
  const writer=createPcConsentChannel({directory,profileId:'pc2-normal',files,clock:()=>1000});writer.start();writer.activate(enabledGrant());
  const auth=new PcAuthorizer({profileId:'pc2-normal',clock:()=>1000});
  const sync=createPcPolicySync({directory,authorizer:auth,files,clock:()=>1000,onRevoked:()=>{throw Error('fixture cleanup failure');}});
  sync.refresh();const state=join(directory,'pc-consent-state.json');const old=files.readPrivateFile(state,32768);
  writer.revoke();sync.refresh();expect(auth.status().enabled).toBe(false);
  files.writePrivateAtomic(state,old);sync.refresh();expect(auth.status().enabled).toBe(false);
});
windowsTest('stale heartbeat, rotated key and expired signed approval fail closed',()=>{
  let now=1000;const directory=join(mkdtempSync(join(tmpdir(),'pc-heartbeat-security-')),'private');
  const writer=createPcConsentChannel({directory,profileId:'pc2-normal',files,clock:()=>now});writer.start();writer.activate(enabledGrant());
  const auth=new PcAuthorizer({profileId:'pc2-normal',clock:()=>now});const sync=createPcPolicySync({directory,authorizer:auth,files,clock:()=>now});
  sync.refresh();expect(auth.status().enabled).toBe(true);now=16001;sync.refresh();expect(auth.status().enabled).toBe(false);
  writer.heartbeat();sync.refresh();expect(auth.status().enabled).toBe(true);
  files.writePrivateAtomic(join(directory,'pc-consent-key'),'0'.repeat(64));sync.refresh();expect(auth.status().enabled).toBe(false);
  now=61000;expect(()=>writer.activate(enabledGrant())).toThrow('pc_access_denied');
});
windowsTest('asynchronous revocation cleanup failure cannot become an unhandled failure or preserve permission',async()=>{
  const directory=join(mkdtempSync(join(tmpdir(),'pc-async-revoke-')),'private');
  const writer=createPcConsentChannel({directory,profileId:'pc2-normal',files,clock:()=>1000});writer.start();writer.activate(enabledGrant());
  const auth=new PcAuthorizer({profileId:'pc2-normal',clock:()=>1000});
  const sync=createPcPolicySync({directory,authorizer:auth,files,clock:()=>1000,onRevoked:async()=>{throw Error('fixture async cleanup failure');}});
  sync.refresh();writer.revoke();sync.refresh();await Bun.sleep(10);
  expect(auth.status().enabled).toBe(false);
});
