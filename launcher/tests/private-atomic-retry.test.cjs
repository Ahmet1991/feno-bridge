const test=require('node:test'),assert=require('node:assert/strict');
const {retrySharingViolation}=require('../electron/private-atomic-retry.cjs');
test('atomic rename retries transient sharing violations with bounded backoff',()=>{
  let calls=0,delays=[];
  const result=retrySharingViolation(()=>{calls++;if(calls<5)throw Object.assign(new Error('busy'),{nativeCode:calls%2?32:33});return 'ok';},
    {sleep:ms=>delays.push(ms)});
  assert.equal(result,'ok');assert.equal(calls,5);assert.ok(delays.reduce((a,b)=>a+b,0)<=300);
});
test('ACL errors are never retried and sharing violations stop after fifth attempt',()=>{
  let calls=0;assert.throws(()=>retrySharingViolation(()=>{calls++;throw Object.assign(new Error('acl'),{nativeCode:5});},{sleep:()=>{}}),/acl/);
  assert.equal(calls,1);calls=0;
  assert.throws(()=>retrySharingViolation(()=>{calls++;throw Object.assign(new Error('busy'),{nativeCode:32});},{sleep:()=>{}}),/busy/);
  assert.equal(calls,5);
});
