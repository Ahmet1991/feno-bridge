"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {names,checkedPath,resolveElectronHelper,resolveRuntimeHelper}=require('../electron/private-acl-location.cjs');
const {assertNoBuildPath}=require('../../scripts/runtime-path-audit.cjs');

test('runtime and Electron ACL helper locations are absolute, pinned and confined',()=>{
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'acl-location-')));
  try{
    const app=path.join(root,'app'), runtime=path.join(root,'runtime');
    fs.mkdirSync(app);fs.mkdirSync(runtime);
    const entry=path.join(app,'cli.js'),exe=path.join(runtime,process.platform==='win32'?'bun.exe':'bun');
    fs.writeFileSync(entry,'entry');fs.writeFileSync(exe,'bun');
    const pins={},files=[];
    for(const name of names){
      fs.writeFileSync(path.join(runtime,name),name);
      pins[name]=createHash('sha256').update(name).digest('hex');
      files.push({path:'runtime/'+name,size:Buffer.byteLength(name),sha256:pins[name]});
    }
    const manifest=path.join(root,'manifest.json');
    fs.writeFileSync(manifest,JSON.stringify({schemaVersion:2,entrypoint:'app/cli.js',files}));
    const helper=path.join(runtime,names[0]);
    assert.equal(resolveRuntimeHelper(entry,exe,pins),helper);
    assert.throws(()=>resolveRuntimeHelper('app/cli.js',exe,pins));
    assert.throws(()=>resolveRuntimeHelper(entry,process.execPath,pins));
    assert.throws(()=>checkedPath(runtime,entry));
    const unpacked=path.join(root,'app.asar.unpacked','electron');fs.mkdirSync(unpacked,{recursive:true});
    fs.writeFileSync(path.join(unpacked,names[0]),'helper');
    assert.equal(resolveElectronHelper(path.join(root,'app.asar','electron','private-acl.cjs')),path.join(unpacked,names[0]));
    assert.equal(resolveElectronHelper(path.join(unpacked,'private-acl.cjs')),path.join(unpacked,names[0]));
    assert.throws(()=>resolveElectronHelper('private-acl.cjs'));
    const linked=path.join(root,'linked');fs.symlinkSync(runtime,linked,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>checkedPath(root,path.join(linked,names[0])));
    assert.throws(()=>checkedPath(linked,path.join(linked,names[0])));
    assert.throws(()=>resolveRuntimeHelper(entry,path.join(linked,path.basename(exe)),pins));
    fs.writeFileSync(helper,'tampered');assert.throws(()=>resolveRuntimeHelper(entry,exe,pins));
    files[0].sha256=createHash('sha256').update('tampered').digest('hex');files[0].size=8;
    fs.writeFileSync(manifest,JSON.stringify({schemaVersion:2,entrypoint:'app/cli.js',files}));
    assert.throws(()=>resolveRuntimeHelper(entry,exe,pins),'modified manifest cannot replace pinned hash');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('runtime audit catches raw, escaped, slash-form and bundled module paths',()=>{
  const forbidden='D:\\GitHub\\checkout';
  for(const text of [forbidden,JSON.stringify(forbidden),forbidden.replace(/\\/g,'/'),'var __dirname="/home/build"','var __filename="/home/build/file.js"']){
    assert.throws(()=>assertNoBuildPath(text,[forbidden],'cli.js'));
  }
  assert.doesNotThrow(()=>assertNoBuildPath('module.filename; import.meta.url; process.argv[1]',[forbidden],'cli.js'));
});
