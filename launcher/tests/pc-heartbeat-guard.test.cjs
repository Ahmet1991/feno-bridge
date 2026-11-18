const test=require('node:test'),assert=require('node:assert/strict');
const {createPcHeartbeatGuard}=require('../electron/pc-heartbeat-guard.cjs');

function fixture(){
  let now=1000,active=true,revocations=0,suspensions=0,channelFault,peerFault;
  const events=[];
  const guard=createPcHeartbeatGuard({clock:()=>now,
    controller:{status:()=>({enabled:active}),suspend:()=>{active=false;suspensions++;}},
    channel:{heartbeat:()=>{if(channelFault)throw channelFault;},revoke:()=>{revocations++;}},
    peers:{heartbeat:()=>{if(peerFault)throw peerFault;}},
    onInactive:()=>{},audit:event=>events.push(event),
  });
  return {guard,events,advance:ms=>{now+=ms;},channelFault:e=>{channelFault=e;},peerFault:e=>{peerFault=e;},
    active:()=>active,revocations:()=>revocations,suspensions:()=>suspensions};
}
const transient=code=>Object.assign(new Error('pc_private_storage'),{code:'pc_private_storage_transient',nativeCode:code});

test('a single EPERM/EBUSY/helper timeout does not silently revoke the grant',()=>{
  for(const error of [transient(5),transient(32),transient(33),Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}),Object.assign(new Error('helper failed'),{code:'pc_private_storage',nativeCode:5})]){
    const f=fixture();f.channelFault(error);f.guard.heartbeat();
    assert.equal(f.active(),true);assert.equal(f.revocations(),0);
    assert.equal(f.guard.status().channelFailures,1);
    assert.ok(f.events.some(e=>e.action==='heartbeat_transient_error'));
  }
});
test('three failures within 30 seconds still allow recovery and reset the counter',()=>{
  const f=fixture();f.channelFault(transient(32));
  for(let i=0;i<3;i++){f.guard.heartbeat();f.advance(2000);}
  assert.equal(f.active(),true);f.channelFault(null);f.guard.heartbeat();
  assert.equal(f.guard.status().channelFailures,0);
  f.channelFault(transient(32));f.advance(30000);f.guard.heartbeat();assert.equal(f.active(),true);
});
test('consecutive failures over 30 seconds suspend once with a sanitized audit record',()=>{
  const f=fixture();f.channelFault(transient(32));f.guard.heartbeat();
  for(let i=0;i<16;i++){f.advance(2000);f.guard.heartbeat();}
  assert.equal(f.active(),false);assert.equal(f.suspensions(),1);assert.equal(f.revocations(),1);
  assert.ok(f.events.some(e=>e.action==='auto_suspended'&&e.reason==='channel_unavailable'&&e.consecutiveFailures>=3));
  assert.equal(typeof f.guard.status().lastAutoStop.at,'number');
});
test('peer heartbeat errors lower coordination readiness without revoking the approval',()=>{
  for(const error of [transient(32),Object.assign(new Error('broken JSON'),{code:'pc_private_storage'})]){
    const f=fixture();f.peerFault(error);f.guard.heartbeat();
    assert.equal(f.active(),true);assert.equal(f.revocations(),0);
    assert.equal(f.guard.status().coordinationReady,false);
    f.peerFault(null);f.guard.heartbeat();assert.equal(f.guard.status().coordinationReady,true);
  }
});
test('malformed native output and ACL security errors fail closed immediately',()=>{
  const f=fixture();f.channelFault(Object.assign(new Error('pc_private_storage'),{code:'pc_private_storage'}));
  f.guard.heartbeat();assert.equal(f.active(),false);assert.equal(f.revocations(),1);
  assert.equal(f.events.find(e=>e.action==='auto_suspended')?.reason,'channel_security_failure');
});

test('wake grace excludes only transient faults and audits the operation',()=>{
  const f=fixture();f.guard.powerEvent();f.channelFault(Object.assign(transient(32),{op:'write'}));
  for(let i=0;i<5;i++){f.guard.heartbeat();f.advance(10000);}
  assert.equal(f.active(),true);assert.equal(f.guard.status().channelFailures,0);
  assert.ok(f.events.some(e=>e.action==='heartbeat_transient_error'&&e.op==='write'&&e.nativeCode===32));
  f.advance(10000);f.guard.heartbeat();
  for(let i=0;i<3;i++){f.advance(10000);f.guard.heartbeat();}
  assert.equal(f.active(),false);
  assert.ok(f.events.some(e=>e.action==='auto_suspended'&&e.op==='write'&&e.nativeCode===32));
  const secure=fixture();secure.guard.powerEvent();secure.channelFault(Object.assign(new Error('invalid ACL'),{code:'pc_private_storage'}));
  secure.guard.heartbeat();assert.equal(secure.active(),false);
});
