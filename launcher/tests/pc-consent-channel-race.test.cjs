'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPcConsentChannel}=require('../electron/pc-consent-channel.cjs');

function fixture(){
  let state,finish;
  const files={
    ensurePrivateDirectory(){},
    writePrivateAtomic(name,content){if(name.endsWith('.json'))state=JSON.parse(content);},
    writePrivateAtomicAsync(name,content){return new Promise(resolve=>{
      finish=()=>{files.writePrivateAtomic(name,content);resolve();};
    });},
  };
  const channel=createPcConsentChannel({directory:'C:\\temp\\consent-channel-race',profileId:'pc2-normal',files});
  channel.start();
  return {channel,state:()=>state,release:()=>{assert.ok(finish);finish();}};
}

test('an earlier asynchronous heartbeat cannot erase a later synchronous approval',async()=>{
  const f=fixture();
  const stale=f.channel.heartbeatAsync();
  f.channel.activate({profileId:'pc2-normal',id:'race-approved-123',expiresAt:Date.now()+60000,
    roots:['C:\\temp'],permissions:['files.read'],allowedApps:[]});
  f.release();await stale;
  assert.equal(f.state().payload.grant.id,'race-approved-123');
});

test('an earlier asynchronous heartbeat cannot resurrect a revoked approval',async()=>{
  const f=fixture();
  f.channel.activate({profileId:'pc2-normal',id:'race-revoked-456',expiresAt:Date.now()+60000,
    roots:['C:\\temp'],permissions:['files.read'],allowedApps:[]});
  const stale=f.channel.heartbeatAsync();
  f.channel.revoke();
  f.release();await stale;
  assert.equal(f.state().payload.grant,null);
});
