const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mkdtempSync = require('./temp-directories.cjs')(test.after);
const sid = process.platform==='win32'?spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows','System32/whoami.exe'), ['/user','/fo','csv','/nh'], {encoding:'utf8',windowsHide:true}).stdout.match(/S-1-5-21-[0-9-]+/)?.[0]:undefined;
const runtime=process.platform==='win32'?{bunPath:spawnSync('bun',['--print','process.execPath'],{encoding:'utf8',windowsHide:true}).stdout.trim()}:{};
function storage() {
  const m=require('../electron/private-acl.cjs');
  return {
    ensurePrivateDirectory:(p,s)=>m.ensurePrivateDirectory(p,s,runtime),
    assertPrivatePath:(p,s,o)=>m.assertPrivatePath(p,s,{...o,...runtime}),
    writePrivateAtomic:(p,b,s)=>m.writePrivateAtomic(p,b,s,runtime),
    readPrivateFile:(p,s,n)=>m.readPrivateFile(p,s,n,runtime),
  };
}
const fixture = (action, target) => {
  const exe=path.join(process.env.SystemRoot || 'C:\\Windows','System32/icacls.exe');
  const saved=action==='widen'?undefined:path.join(mkdtempSync(path.join(os.tmpdir(),'feno-acl-save-')),'acl.txt');
  const args=action==='widen'?[target,'/grant','*S-1-1-0:(R)','/q']:[target,'/save',saved,'/q'];
  const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true}); assert.equal(r.status,0,r.stderr);
  if(action==='widen')return;
  const sddl=fs.readFileSync(saved,'utf16le').split(/\r?\n/).find(l=>l.startsWith('D:'));
  assert.ok(sddl);
  return {protected:sddl.startsWith('D:P'),rules:[...sddl.matchAll(/\(([^;]+);[^;]*;[^;]*;[^;]*;[^;]*;([^)]*)\)/g)].map(m=>({type:m[1]==='A'?'Allow':m[1],sid:({SY:'S-1-5-18',BA:'S-1-5-32-544'})[m[2]]||m[2]}))};
};
const windows = {skip:process.platform !== 'win32'};

test('private writes inherit no broad-reader access and remain private after replacement', windows, () => {
  const api = storage();
  const root = mkdtempSync(path.join(os.tmpdir(),'feno-acl-'));
  const directory=path.join(root,'private');
  api.ensurePrivateDirectory(directory,sid);
  const file=path.join(directory,'fixture.json');
  api.writePrivateAtomic(file,Buffer.from('first fixture'),sid);
  api.writePrivateAtomic(file,Buffer.from('second fixture'),sid);
  assert.equal(api.readPrivateFile(file,sid,1024).toString(),'second fixture');
  for(const target of [directory,file]) {
    const acl=fixture('inspect',target);
    assert.equal(acl.protected,true);
    assert.deepEqual(acl.rules.map(r=>r.sid).sort(),[sid,'S-1-5-18','S-1-5-32-544'].sort());
    assert.ok(acl.rules.every(r=>r.type==='Allow'));
  }
  assert.deepEqual(fs.readdirSync(directory),['fixture.json']);
});

test('broad ACL, excessive reads and foreign owner policy fail closed without rewriting existing files', windows, () => {
  const api=storage();
  const root=mkdtempSync(path.join(os.tmpdir(),'feno-acl-deny-'));
  const directory=path.join(root,'private'); api.ensurePrivateDirectory(directory,sid);
  const file=path.join(directory,'fixture.txt'); api.writePrivateAtomic(file,'unchanged',sid);
  assert.throws(()=>api.readPrivateFile(file,sid,2),/pc_private_storage/);
  fixture('widen',file);
  assert.throws(()=>api.assertPrivatePath(file,sid,{directory:false}),/pc_private_storage/);
  assert.throws(()=>api.readPrivateFile(file,sid,1024),/pc_private_storage/);
  assert.throws(()=>api.writePrivateAtomic(file,'replacement',sid),/pc_private_storage/);
  assert.equal(fs.readFileSync(file,'utf8'),'unchanged');
  const other=path.join(root,'foreign');
  assert.throws(()=>api.ensurePrivateDirectory(other,'S-1-5-18'),/pc_private_storage/);
  assert.equal(fs.existsSync(other),false);
});

test('junction targets cannot redirect a private write or read', windows, () => {
  const api=storage();
  const root=mkdtempSync(path.join(os.tmpdir(),'feno-acl-junction-'));
  const directory=path.join(root,'private'); api.ensurePrivateDirectory(directory,sid);
  const alias=path.join(root,'alias'); fs.symlinkSync(directory,alias,'junction');
  assert.throws(()=>api.writePrivateAtomic(path.join(alias,'unexpected.txt'),'fixture',sid),/pc_private_storage/);
  assert.equal(fs.existsSync(path.join(directory,'unexpected.txt')),false);
  assert.throws(()=>api.ensurePrivateDirectory(alias,sid),/pc_private_storage/);
});
