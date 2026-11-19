import {afterAll,test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, linkSync, existsSync, renameSync} from 'node:fs';
import { trackTempDirectories } from './support/temp-directories';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PcAuthorizer} from '../src/pc-control/authorization';

const mkdtempSync = trackTempDirectories(afterAll);

// The Windows backend must not be imported while registering non-Windows tests.
const modulePath='../src/pc-control/files';
const api=await import(modulePath).catch(()=>undefined);
const windowsTest=process.platform==='win32'?test:test.skip;
function fixture(){
  const base=mkdtempSync(join(tmpdir(),'pc-files-task4-'));
  const root=join(base,'project');mkdirSync(root);
  const auth=new PcAuthorizer({profileId:'pc2-normal'});
  auth.setGrantFromLocalApproval({profileId:'pc2-normal',id:'files-fixture-0001',expiresAt:Date.now()+60000,roots:[root],permissions:['files.read','files.write'],allowedApps:[]});
  return {base,root,auth};
}
const sha=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
function implementation(){expect(typeof api?.readPcFile).toBe('function');return api!;}

test('all file entry points enforce deny-by-default before native I/O',async()=>{
  const files=implementation(),auth=new PcAuthorizer({profileId:'pc2-normal'});
  for(const call of [()=>files.listPcFiles('D:\\project','',auth),()=>files.readPcFile('D:\\project\\a.txt',auth),()=>files.createPcFile('D:\\project\\a.txt','x',auth),()=>files.createPcDirectory('D:\\project\\new',auth),()=>files.applyPcPatch('D:\\project\\a.txt','0'.repeat(64),'@@ -1 +1 @@\n-a\n+b\n',auth)])await expect(call()).rejects.toThrow('pc_access_denied');
});
windowsTest('create publishes complete bytes and readback returns the actual hash',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'hello.txt');
  expect(await files.createPcFile(file,'hello\r\n',auth)).toEqual({path:file,sha256:sha('hello\r\n')});
  expect(await files.readPcFile(file,auth)).toEqual({path:file,content:'hello\r\n',sha256:sha('hello\r\n')});
  expect(readFileSync(file,'utf8')).toBe('hello\r\n');
  expect(readdirSync(root)).toEqual(['hello.txt']);
});
windowsTest('create never overwrites an existing file or directory',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'keep.txt');writeFileSync(file,'keep');
  await expect(files.createPcFile(file,'replace',auth)).rejects.toThrow('pc_file_exists');
  expect(readFileSync(file,'utf8')).toBe('keep');
  const directory=join(root,'new');expect(await files.createPcDirectory(directory,auth)).toEqual({path:directory});
  expect(await files.createPcDirectory(directory,auth)).toEqual({path:directory,existed:true});
  await expect(files.createPcDirectory(file,auth)).rejects.toThrow('pc_path_is_file');
  expect(readdirSync(root).sort()).toEqual(['keep.txt','new']);
});
for(const [name,original,patch,want] of [
  ['LF','one\ntwo\n','@@ -1,2 +1,2 @@\n one\n-two\n+three\n','one\nthree\n'],
  ['CRLF','one\r\ntwo\r\n','@@ -1,2 +1,2 @@\n one\n-two\n+three\n','one\r\nthree\r\n'],
  ['mixed endings','one\r\ntwo\nthree\r\n','@@ -2 +2 @@\n-two\n+second\n','one\r\nsecond\r\nthree\r\n'],
  ['no final newline','one\ntwo','@@ -2 +2 @@\n-two\n+three\n','one\nthree'],
  ['empty file','','@@ -0,0 +1,1 @@\n+one\n','one\n'],
] as const)windowsTest(`patch preserves ${name} semantics`,async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'patch.txt');writeFileSync(file,original);
  expect(await files.applyPcPatch(file,sha(original),patch,auth)).toEqual({path:file,newSha256:sha(want)});
  expect(readFileSync(file,'utf8')).toBe(want);expect(readdirSync(root)).toEqual(['patch.txt']);
});
windowsTest('SHA conflict keeps the original bytes and the dedicated error code',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'patch.txt');writeFileSync(file,'one\n');
  await expect(files.applyPcPatch(file,'0'.repeat(64),'@@ -1 +1 @@\n-one\n+two\n',auth)).rejects.toMatchObject({code:'pc_sha_mismatch'});
  expect(readFileSync(file,'utf8')).toBe('one\n');expect(readdirSync(root)).toEqual(['patch.txt']);
});
windowsTest('missing authorized leaf is classified without revealing outside paths',async()=>{
  const files=implementation(),{root,base,auth}=fixture();
  await expect(files.readPcFile(join(root,'missing.txt'),auth)).rejects.toMatchObject({code:'pc_file_not_found'});
  await expect(files.readPcFile(join(base,'missing.txt'),auth)).rejects.toMatchObject({code:'pc_access_denied'});
});
windowsTest('Chrome upload holds native read boundaries, limits files and rejects credentials',async()=>{
  const files=implementation(),{root,base,auth}=fixture(),file=join(root,'upload.bin');writeFileSync(file,Buffer.from([0,1,2,3]));
  let sent=0;const send=async(paths:string[])=>{sent++;expect(paths).toEqual([file]);return true;};
  expect(await files.withPcUploadFiles([file],auth,send)).toBe(true);
  for(const [p,code] of [[join(base,'outside.txt'),'pc_access_denied'],[join(root,'absent.txt'),'pc_file_not_found'],[join(root,'.ssh','id_ed25519'),'pc_sensitive_path'],[join(root,'token.json'),'pc_sensitive_path']])await expect(files.withPcUploadFiles([p],auth,send)).rejects.toThrow(code!);
  const big=join(root,'big.bin');writeFileSync(big,Buffer.alloc(100*1024*1024+1));await expect(files.withPcUploadFiles([big],auth,send)).rejects.toThrow('pc_file_too_large');
  const secret=join(root,'ordinary.txt');writeFileSync(secret,'password=fixture');await expect(files.withPcUploadFiles([secret],auth,send)).rejects.toThrow('pc_sensitive_path');
  expect(sent).toBe(1);
});
windowsTest('sensitive names and content are rejected for reads, creates and patches',async()=>{
  const files=implementation(),{root,auth}=fixture();
  for(const name of ['.env','.env.local','.npmrc','id_rsa','credentials.json','secret.txt','private.pem','.git/config','CON','aux.txt','trailing.','stream.txt:secret']){
    const file=join(root,name);await expect(files.createPcFile(file,'ordinary',auth)).rejects.toThrow(/pc_sensitive_path|pc_access_denied/);
  }
  const file=join(root,'ordinary.txt');writeFileSync(file,'password = secret-value\n');
  await expect(files.readPcFile(file,auth)).rejects.toThrow('pc_sensitive_path');
  for(const value of ['api_key=example','-----BEGIN PRIVATE KEY-----','authorization: Bearer example','a\0b','\ud800'])await expect(files.createPcFile(join(root,'new.txt'),value,auth)).rejects.toThrow(/pc_sensitive_path|pc_access_denied/);
  writeFileSync(file,'ordinary\n');
  await expect(files.applyPcPatch(file,sha('ordinary\n'),'@@ -1 +1 @@\n-ordinary\n+access_token=example\n',auth)).rejects.toThrow('pc_sensitive_path');
  expect(readFileSync(file,'utf8')).toBe('ordinary\n');expect(existsSync(join(root,'new.txt'))).toBe(false);
});
windowsTest('bounded UTF8 rejects oversized, malformed and binary files without mutation',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'data.txt');
  for(const bytes of [Buffer.from([0xc3,0x28]),Buffer.from([65,0,66]),Buffer.alloc(2*1024*1024+1,65)]){
    writeFileSync(file,bytes);await expect(files.readPcFile(file,auth)).rejects.toThrow(bytes.length>2*1024*1024?'pc_file_too_large':'pc_access_denied');expect(readFileSync(file)).toEqual(bytes);
  }
  await expect(files.createPcFile(join(root,'large.txt'),'a'.repeat(2*1024*1024+1),auth)).rejects.toThrow('pc_access_denied');
});
windowsTest('five megabyte log supports bounded offset and tail reads with explicit limits',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'big.log');
  writeFileSync(file,'row one\n'+('x'.repeat(5*1024*1024))+'\nlast row\n');
  await expect(files.readPcFile(file,auth)).rejects.toMatchObject({code:'pc_file_too_large',details:{limitBytes:2*1024*1024}});
  const chunk=await files.readPcFile(file,auth,{offset:0,length:8});
  expect(chunk).toMatchObject({content:'row one\n',partial:true,sizeBytes:5*1024*1024+18,nextOffset:8});
  const tail=await files.readPcFile(file,auth,{tailLines:1});
  expect(tail.content).toBe('last row\n');
});
windowsTest('listing filters secrets and rejects traversal and oversized directories',async()=>{
  const files=implementation(),{root,auth}=fixture();mkdirSync(join(root,'src'));writeFileSync(join(root,'visible.txt'),'ok');writeFileSync(join(root,'.env'),'hidden');mkdirSync(join(root,'.git'));
  const listing=await files.listPcFiles(root,'',auth);
  expect(listing.entries.map((e:any)=>[e.name,e.kind])).toEqual([['src','directory'],['visible.txt','file']]);
  expect(listing.entries.find((e:any)=>e.name==='visible.txt')?.sizeBytes).toBe(2);
  expect(typeof listing.entries.find((e:any)=>e.name==='visible.txt')?.modifiedAt).toBe('string');
  expect(listing.pagination).toEqual({offset:0,limit:100,total:2,nextOffset:null});
  expect(listing.omitted).toEqual({sensitive:true,junctions:true});
  for(const relative of ['..','src/../','D:\\outside','/outside'])await expect(files.listPcFiles(root,relative,auth)).rejects.toThrow('pc_invalid_argument');
  for(let i=0;i<501;i++)writeFileSync(join(root,`entry-${i}.txt`),'x');
  const page=await files.listPcFiles(root,'',auth,0,25);
  expect(page.entries).toHaveLength(25);expect(page.pagination).toMatchObject({limit:25,total:503,nextOffset:25});
});
windowsTest('junction and hardlink aliases cannot cross or disguise approved boundaries',async()=>{
  const files=implementation(),{root,base,auth}=fixture(),outside=join(base,'outside');mkdirSync(outside);writeFileSync(join(outside,'value.txt'),'outside\n');
  symlinkSync(outside,join(root,'escape'),'junction');symlinkSync(root,join(root,'inside-alias'),'junction');linkSync(join(outside,'value.txt'),join(root,'hard.txt'));
  for(const file of [join(root,'escape','value.txt'),join(root,'hard.txt')]){
    await expect(files.readPcFile(file,auth)).rejects.toThrow('pc_access_denied');await expect(files.applyPcPatch(file,sha('outside\n'),'@@ -1 +1 @@\n-outside\n+changed\n',auth)).rejects.toThrow('pc_access_denied');
  }
  await expect(files.createPcFile(join(root,'escape','new.txt'),'x',auth)).rejects.toThrow('pc_access_denied');
  await expect(files.createPcDirectory(join(root,'inside-alias','new'),auth)).rejects.toThrow('pc_access_denied');
  expect((await files.listPcFiles(root,'',auth)).entries).toEqual([]);expect(readFileSync(join(outside,'value.txt'),'utf8')).toBe('outside\n');
});
windowsTest('concurrent stale patches publish one complete winner',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'race.txt');writeFileSync(file,'one\n');
  const results=await Promise.allSettled(['two','three'].map(word=>files.applyPcPatch(file,sha('one\n'),`@@ -1 +1 @@\n-one\n+${word}\n`,auth)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(['two\n','three\n']).toContain(readFileSync(file,'utf8'));expect(readdirSync(root)).toEqual(['race.txt']);
});
windowsTest('replacing the local grant before commit cannot inherit an in-flight operation',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'keep.txt');writeFileSync(file,'one\n');
  const original=auth.assert.bind(auth);let calls=0;
  auth.assert=((permission:any)=>{if(permission==='files.write'&&++calls===2)auth.revoke();return original(permission);}) as typeof auth.assert;
  await expect(files.applyPcPatch(file,sha('one\n'),'@@ -1 +1 @@\n-one\n+two\n',auth)).rejects.toThrow('pc_access_denied');
  expect(readFileSync(file,'utf8')).toBe('one\n');expect(readdirSync(root)).toEqual(['keep.txt']);
});
windowsTest('native read sessions pin every ancestor and the leaf during actual I/O',async()=>{
  const files=implementation(),{root,base,auth}=fixture(),file=join(root,'pinned.txt');writeFileSync(file,'one\n');
  const {ProjectFileSession}=await import('../src/pc-control/project-file-native');
  const hold=new ProjectFileSession(file,[root],'file');
  try{
    expect(()=>renameSync(root,join(base,'moved'))).toThrow();
    expect(()=>renameSync(file,join(root,'moved.txt'))).toThrow();
    expect(()=>writeFileSync(file,'bad')).toThrow();
    expect(hold.read().toString()).toBe('one\n');
    await expect(files.applyPcPatch(file,sha('one\n'),'@@ -1 +1 @@\n-one\n+two\n',auth)).rejects.toThrow('pc_access_denied');
    expect(hold.read().toString()).toBe('one\n');expect(readdirSync(root)).toEqual(['pinned.txt']);
  }finally{hold.close();}
  expect((await files.readPcFile(file,auth)).content).toBe('one\n');
});
windowsTest('new files and directories have an explicit private Windows ACL',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'private.txt'),directory=join(root,'private-dir');
  const native=require('../launcher/electron/private-acl-native.cjs');
  await files.createPcFile(file,'safe\n',auth);await files.createPcDirectory(directory,auth);
  expect(()=>native.assertPrivatePath(file,native.getCurrentUserSid())).not.toThrow();
  expect(()=>native.assertPrivatePath(directory,native.getCurrentUserSid(),{directory:true})).not.toThrow();
});
windowsTest('changed grant identity prevents create publication and cleans staging',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'new.txt');const original=auth.assert.bind(auth);let calls=0;
  auth.assert=((permission:any)=>{
    if(permission==='files.write'&&++calls===2)auth.setGrantFromLocalApproval({profileId:'pc2-normal',id:'replacement-grant-0002',expiresAt:Date.now()+60000,roots:[root],permissions:['files.read','files.write'],allowedApps:[]});
    return original(permission);
  }) as typeof auth.assert;
  await expect(files.createPcFile(file,'safe\n',auth)).rejects.toThrow('pc_access_denied');expect(readdirSync(root)).toEqual([]);
});
windowsTest('malformed or context-mismatched hunks preserve the original without staging leaks',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'keep.txt');writeFileSync(file,'one\ntwo\n');
  for(const patch of ['@@ -1 +1 @@\n-wrong\n+three\n','@@ -1,2 +1 @@\n-one\n+three\n','@@ -1 +9 @@\n-one\n+three\n','invalid','a'.repeat(256*1024+1)]){
    await expect(files.applyPcPatch(file,sha('one\ntwo\n'),patch,auth)).rejects.toThrow('pc_access_denied');expect(readFileSync(file,'utf8')).toBe('one\ntwo\n');
  }
  expect(readdirSync(root)).toEqual(['keep.txt']);
});
windowsTest('quoted JSON credentials are sensitive',async()=>{
  const files=implementation(),{root,auth}=fixture();
  for(const value of ['{"password":"example"}','{"access_token": "example"}','{"authorization":"Bearer example"}','{"client_secret":"example"}'])await expect(files.createPcFile(join(root,'data.json'),value,auth)).rejects.toThrow('pc_sensitive_path');
});
windowsTest('UTF8 BOM bytes survive reads and patches',async()=>{
  const files=implementation(),{root,auth}=fixture(),file=join(root,'bom.txt');
  writeFileSync(file,'\ufeffone\ntwo\n');expect((await files.readPcFile(file,auth)).content).toBe('\ufeffone\ntwo\n');
  await files.applyPcPatch(file,sha('\ufeffone\ntwo\n'),'@@ -2 +2 @@\n-two\n+three\n',auth);expect(readFileSync(file,'utf8')).toBe('\ufeffone\nthree\n');
});
