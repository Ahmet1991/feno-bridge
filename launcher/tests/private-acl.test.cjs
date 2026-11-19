const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  const saved=path.join(path.dirname(path.dirname(target)),'acl-'+Date.now()+'.txt');
  const args=action==='widen'?[target,'/grant','*S-1-1-0:(R)','/q']:[target,'/save',saved,'/q'];
  const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true}); assert.equal(r.status,0,r.stderr);
  if(action==='widen')return;
  const sddl=fs.readFileSync(saved,'utf16le').split(/\r?\n/).find(l=>l.startsWith('D:'));
  assert.ok(sddl);
  return sddl;
};
const windows = {skip:process.platform !== 'win32'};

test('private writes inherit no broad-reader access and remain private after replacement', windows, () => {
  const api = storage();
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'feno-acl-'));
  const directory=path.join(root,'private');
  api.ensurePrivateDirectory(directory,sid);
  const file=path.join(directory,'fixture.json');
  api.writePrivateAtomic(file,Buffer.from('first fixture'),sid);
  api.writePrivateAtomic(file,Buffer.from('second fixture'),sid);
  assert.equal(api.readPrivateFile(file,sid,1024).toString(),'second fixture');
  for(const target of [directory,file]) {
    const acl=fixture('inspect',target);
    assert.ok(acl.startsWith('D:P'));
    // icacls may serialize the same trustee as LA/LG. Validate the full
    // independent saved DACL, plus the actual file's owner and ACL by handle.
    require('../electron/private-acl-native.cjs').assertPrivateSddl('O:'+sid+acl,sid,target===directory);
    api.assertPrivatePath(target,sid,{directory:target===directory});
  }
  assert.deepEqual(fs.readdirSync(directory),['fixture.json']);
});

test('binary ACL comparison accepts RID-500 and the local LA alias, rejects wrong trustees and weakened ACEs', windows, () => {
  const native=require('../electron/private-acl-native.cjs');
  const fake='S-1-5-21-12345-23456-34567-500';
  const {dlopen,toArrayBuffer}=require('bun:ffi');
  const sys=path.join(process.env.SystemRoot||'C:\\Windows','System32');
  const adv=dlopen(path.join(sys,'advapi32.dll'),{
    ConvertStringSecurityDescriptorToSecurityDescriptorW:{args:['ptr','u32','ptr','ptr'],returns:'bool'},
    GetSecurityDescriptorOwner:{args:['ptr','ptr','ptr'],returns:'bool'},
    ConvertSidToStringSidW:{args:['ptr','ptr'],returns:'bool'},
  });
  const kernel=dlopen(path.join(sys,'kernel32.dll'),{LocalFree:{args:['ptr'],returns:'ptr'}});
  const pointer=b=>Number(b.readBigUInt64LE());
  let descriptor,ownerString;
  try{
    const sd=Buffer.alloc(8),owner=Buffer.alloc(8),out=Buffer.alloc(8);
    assert.ok(adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(Buffer.from('O:LA\0','utf16le'),1,sd,null));
    descriptor=pointer(sd);
    assert.ok(adv.symbols.GetSecurityDescriptorOwner(descriptor,owner,Buffer.alloc(4)));
    assert.ok(adv.symbols.ConvertSidToStringSidW(pointer(owner),out));
    ownerString=pointer(out);
    let localAdmin='';
    for(let i=0;i<256;i++){
      const n=Buffer.from(toArrayBuffer(ownerString+i*2,0,2)).readUInt16LE();
      if(!n)break;localAdmin+=String.fromCharCode(n);
    }
    assert.match(localAdmin,/^S-1-5-21-(?:\d+-){3}500$/);
    const policy=(user,flags='',rights='FA')=>'O:'+user+'D:P(A;'+flags+';'+rights+';;;'+user+')(A;'+flags+';FA;;;SY)(A;'+flags+';FA;;;BA)';
    assert.doesNotThrow(()=>native.assertPrivateSddl(policy(fake),fake));
    assert.doesNotThrow(()=>native.assertPrivateSddl(policy('LA'),localAdmin));
    assert.doesNotThrow(()=>native.assertPrivateSddl(policy('LA','OICI'),localAdmin,true));
    for(const bad of [policy(fake).replace('D:P','D:'),policy(fake,'OI'),policy(fake,'','FR'),
      policy(fake).replace(';;;BA',';;;WD'),policy(fake).replace(';;;BA',';;;SY'),
      policy(fake).replace('(A;;FA;;;BA)','(D;;FA;;;BA)'),policy(fake)+'(A;;FA;;;WD)',
      policy(fake).replace(';;;'+fake,';;;S-1-5-21-12345-23456-34567-501')]){
      assert.throws(()=>native.assertPrivateSddl(bad,fake),/pc_private_storage/);
    }
    assert.throws(()=>native.assertPrivateSddl(policy('LA'),fake),/pc_private_storage/);
  }finally{
    if(ownerString)kernel.symbols.LocalFree(ownerString);
    if(descriptor)kernel.symbols.LocalFree(descriptor);
    adv.close();kernel.close();
  }
});

test('broad ACL, excessive reads and foreign owner policy fail closed without rewriting existing files', windows, () => {
  const api=storage();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feno-acl-deny-'));
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
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feno-acl-junction-'));
  const directory=path.join(root,'private'); api.ensurePrivateDirectory(directory,sid);
  const alias=path.join(root,'alias'); fs.symlinkSync(directory,alias,'junction');
  assert.throws(()=>api.writePrivateAtomic(path.join(alias,'unexpected.txt'),'fixture',sid),/pc_private_storage/);
  assert.equal(fs.existsSync(path.join(directory,'unexpected.txt')),false);
  assert.throws(()=>api.ensurePrivateDirectory(alias,sid),/pc_private_storage/);
});
