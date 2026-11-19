const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const mkdtempSync = require('./temp-directories.cjs')(test.after);
const runtime=process.platform==='win32'?{bunPath:cp.spawnSync('bun',['--print','process.execPath'],{encoding:'utf8'}).stdout.trim()}:{};
const sid=process.platform==='win32'?require('../electron/private-acl.cjs').getNativeSecurityContext(runtime).userSid:undefined;
const windowsTest=(name,fn)=>test(name,{skip:process.platform!=='win32'},fn);
const selection={durationMs:null,roots:['D:\\GitHub\\fixture'],permissions:['files.read'],allowedApps:[]};
function setup(profileId='pc2-normal') {
  const {createPrivateFileAccess,createWindowsDpapiProtection}=require('../electron/private-acl.cjs');
  const files=createPrivateFileAccess(sid,runtime);
  const directory=path.join(mkdtempSync(path.join(os.tmpdir(),'pc-store-security-')),'private');files.ensurePrivateDirectory(directory);
  const encryption=createWindowsDpapiProtection(sid,profileId,runtime);
  return {profileId,files,encryption,filePath:path.join(directory,'consent.enc')};
}
windowsTest('DPAPI bytes remain valid after crossing the native allocation boundary',()=>{
  const context=setup();const encrypted=context.encryption.encryptString('isolated DPAPI fixture');
  assert.equal(context.encryption.decryptString(encrypted),'isolated DPAPI fixture');
  assert.equal(context.encryption.isEncryptionAvailable(),true);
});
windowsTest('DEV retirement receipt is DPAPI bound to normal profile and rejects fake, corrupt and wrong-profile records',()=>{
  const context=setup('pc2-normal');
  const {createPcDevRetirementStore}=require('../electron/pc-dev-retirement.cjs');
  const directory=path.dirname(context.filePath),file=path.join(directory,'pc2-normal-dev-retirement.enc');
  const store=createPcDevRetirementStore({directory,files:context.files,encryption:context.encryption});
  assert.equal(store.read(),false);
  store.set(true);assert.equal(store.read(),true);
  const authentic=context.files.readPrivateFile(file,8192);
  context.files.writePrivateAtomic(file,Buffer.from('{"retired":true}'));
  assert.equal(store.read(),false);
  const wrong={schema:1,profileId:'pc2-dev',purpose:'dev-retirement',retired:true,nonce:'00000000-0000-4000-8000-000000000000'};
  context.files.writePrivateAtomic(file,context.encryption.encryptString(JSON.stringify(wrong)));
  assert.equal(store.read(),false);
  context.files.writePrivateAtomic(file,authentic);
  assert.equal(store.read(),true);
  const inaccessible=createPcDevRetirementStore({directory,files:{...context.files,readPrivateFile(){throw Error('bad ACL');}},encryption:context.encryption});
  assert.equal(inaccessible.read(),false);
  store.set(false);assert.equal(store.read(),false);
});
windowsTest('persistent approval round-trips through real CurrentUser DPAPI and remains profile bound',()=>{
  const {createPcPersistentConsent}=require('../electron/pc-persistent-consent.cjs');const context=setup();
  const store=createPcPersistentConsent(context);store.save(selection);const restored=store.restore();
  assert.deepEqual(restored,selection);assert.equal(store.isTrustedSelection(restored),true);
  const foreign=createPcPersistentConsent({...context,profileId:'pc2-dev'});assert.equal(foreign.restore(),null);
  assert.equal(fs.existsSync(context.filePath),true);
  store.clear();assert.equal(store.isTrustedSelection(restored),false);
});
windowsTest('storage failure cannot enable perpetual access or accept a fabricated restore receipt',async()=>{
  const {createPcConsentController}=require('../electron/pc-consent.cjs');
  const controller=createPcConsentController({profileId:'pc2-normal',confirmLocally:async()=>true});
  await assert.rejects(controller.approve(selection),/pc_access_denied/);assert.equal(controller.status().enabled,false);
  assert.throws(()=>controller.restoreTrustedPersistentSelection(selection),/pc_access_denied/);
  const {createPcPersistentConsent}=require('../electron/pc-persistent-consent.cjs');const context=setup();
  const broken=createPcPersistentConsent({...context,encryption:{...context.encryption,isEncryptionAvailable:()=>false}});
  const other=createPcConsentController({profileId:'pc2-normal',confirmLocally:async()=>true,store:broken});
  await assert.rejects(other.approve(selection),/pc_access_denied/);assert.equal(other.status().enabled,false);
});
windowsTest('invalid encrypted state is quarantined, while unavailable encryption leaves existing data untouched',()=>{
  const {createPcPersistentConsent}=require('../electron/pc-persistent-consent.cjs');const context=setup();
  context.files.writePrivateAtomic(context.filePath,Buffer.from('corrupt fixture'));
  const store=createPcPersistentConsent(context);assert.equal(store.restore(),null);
  assert.equal(fs.existsSync(context.filePath),false);
  assert.equal(fs.readdirSync(path.dirname(context.filePath)).filter(n=>n.includes('.quarantine-')).length,1);
  store.save(selection);const original=fs.readFileSync(context.filePath);
  const unavailable=createPcPersistentConsent({...context,encryption:{...context.encryption,isEncryptionAvailable:()=>false}});
  assert.equal(unavailable.restore(),null);assert.deepEqual(fs.readFileSync(context.filePath),original);
});
windowsTest('DEV legacy encrypted selection restores only on explicit DEV opt-in without rewriting it',()=>{
  const {createPcPersistentConsent}=require('../electron/pc-persistent-consent.cjs');const context=setup('pc2-dev');
  context.files.writePrivateAtomic(context.filePath,context.encryption.encryptString(JSON.stringify({schema:1,selection})));
  const before=fs.readFileSync(context.filePath);
  assert.equal(createPcPersistentConsent(context).restore(),null);
  const store=createPcPersistentConsent({...context,allowLegacyDevSelection:true});assert.deepEqual(store.restore(),selection);
  assert.deepEqual(fs.readFileSync(context.filePath),before);
  assert.throws(()=>createPcPersistentConsent({...context,profileId:'pc2-normal',allowLegacyDevSelection:true}),/pc_access_denied/);
});
test('revoking pending local approval prevents activation after the dialog returns',async()=>{
  const {createPcConsentController}=require('../electron/pc-consent.cjs');let finish;
  const controller=createPcConsentController({profileId:'pc2-normal',confirmLocally:()=>new Promise(r=>finish=r)});
  const pending=controller.approve({...selection,durationMs:60000});controller.revoke();finish(true);
  await assert.rejects(pending,/pc_access_denied/);assert.equal(controller.status().enabled,false);
});
windowsTest('an encryption-provider outage returns disabled restore instead of a launcher-startup exception',()=>{
  const {createPcPersistentConsent}=require('../electron/pc-persistent-consent.cjs');const context=setup();
  const store=createPcPersistentConsent({...context,encryption:{...context.encryption,isEncryptionAvailable:()=>{throw Error('fixture protection outage');}}});
  assert.equal(store.restore(),null);assert.equal(store.isProtectionAvailable(),false);
});

windowsTest('an invalid clock revokes a running grant and cannot restore a saved approval',async()=>{
  const {createPcConsentController}=require('../electron/pc-consent.cjs');
  const {createPcPersistentConsent}=require('../electron/pc-persistent-consent.cjs');
  let now=1000;const context=setup();const store=createPcPersistentConsent(context);
  const controller=createPcConsentController({profileId:'pc2-normal',clock:()=>now,confirmLocally:async()=>true,store});
  await controller.approve({...selection,durationMs:60000});
  now=NaN;assert.equal(controller.status().enabled,false);
  store.save(selection);const saved=store.restore();
  assert.throws(()=>controller.restoreTrustedPersistentSelection(saved),/pc_access_denied/);
  assert.equal(controller.status().enabled,false);
});

windowsTest('persistent revoke survives failed deletion and a fresh store instance cannot resurrect it',async()=>{
  const {createPcPersistentConsent}=require('../electron/pc-persistent-consent.cjs');
  const {createPcConsentController}=require('../electron/pc-consent.cjs');
  const context=setup();const files={...context.files,removePrivateFile(){throw Error('fixture file is busy');}};
  const store=createPcPersistentConsent({...context,files});
  const controller=createPcConsentController({profileId:'pc2-normal',confirmLocally:async()=>true,store});
  await controller.approve(selection);const receipt=store.restore();
  controller.revoke();
  assert.equal(controller.status().enabled,false);assert.equal(store.isTrustedSelection(receipt),false);
  assert.equal(store.restore(),null);
  assert.equal(createPcPersistentConsent(context).restore(),null);
});

windowsTest('failed durable revoke suppresses restoration in memory and signals unresolved persistence',async()=>{
  const {createPcPersistentConsent}=require('../electron/pc-persistent-consent.cjs');const context=setup();
  const store=createPcPersistentConsent(context);store.save(selection);const receipt=store.restore();
  const broken=createPcPersistentConsent({...context,files:{...context.files,writePrivateAtomic(){throw Error('fixture disk failure');},removePrivateFile(){throw Error('fixture disk failure');}}});
  assert.throws(()=>broken.clear(),/fixture disk failure/);
  assert.equal(broken.restore(),null);
  const {createPcConsentController}=require('../electron/pc-consent.cjs');
  const controller=createPcConsentController({profileId:'pc2-normal',confirmLocally:async()=>true,store:broken});
  assert.throws(()=>controller.revoke(),/fixture disk failure/);
  assert.deepEqual(controller.status(),{enabled:false,persistentRevocationPending:true});
  await assert.rejects(controller.approve({...selection,durationMs:60000}),/pc_access_denied/);
  store.save({...selection,permissions:['files.write']});assert.equal(store.isTrustedSelection(receipt),false);
});
