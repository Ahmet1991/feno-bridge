'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const child=require('node:child_process');

test('native helper transient sharing violations and timeouts remain distinct from security errors',t=>{
  const original=child.spawnSync;
  let response;
  child.spawnSync=()=>response;
  t.after(()=>{child.spawnSync=original;});
  delete require.cache[require.resolve('../electron/private-acl.cjs')];
  const {getNativeSecurityContext}=require('../electron/private-acl.cjs');
  const run=()=>getNativeSecurityContext({bunPath:process.execPath});
  for(const code of [32,33]){
    response={status:1,stdout:JSON.stringify({ok:false,code:'pc_private_storage_transient',nativeCode:code})};
    assert.throws(run,error=>error.code==='pc_private_storage_transient'&&error.nativeCode===code);
  }
  response={error:Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})};
  assert.throws(run,error=>error.code==='pc_private_storage_transient');
  for(const output of ['{broken',JSON.stringify({ok:false,code:'pc_private_storage_transient',nativeCode:5})]){
    response={status:1,stdout:output};
    assert.throws(run,error=>error.code==='pc_private_storage');
  }
  response={status:0,stdout:'{broken'};
  assert.throws(run,error=>error.code==='pc_private_storage');
  response={status:0,stdout:'{"ok":true}'};
  assert.equal(run().ok,true);
});
