'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseNativeResult,getNativeSecurityContext}=require('../electron/private-acl.cjs');

test('native helper transient sharing violations and timeouts remain distinct from security errors',()=>{
  let response;
  const run=()=>parseNativeResult(response);
  for(const code of [5,32,33]){
    response={status:1,stdout:JSON.stringify({ok:false,code:'pc_private_storage_transient',nativeCode:code})};
    assert.throws(run,error=>error.code==='pc_private_storage_transient'&&error.nativeCode===code);
  }
  response={error:Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})};
  assert.throws(run,error=>error.code==='pc_private_storage_transient');
  response={status:1,stdout:'{broken'};
  assert.throws(run,error=>error.code==='pc_private_storage');
  response={status:0,stdout:'{broken'};
  assert.throws(run,error=>error.code==='pc_private_storage');
  response={status:0,stdout:'{"ok":true}'};
  assert.equal(run().ok,true);
});

test('native security context fails closed outside Windows',{skip:process.platform==='win32'},()=>{
  assert.throws(()=>getNativeSecurityContext({bunPath:process.execPath}),error=>error.code==='pc_private_storage');
});
