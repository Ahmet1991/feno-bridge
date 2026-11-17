const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');

test('normal and DEV start disabled and derive separate local stores from trusted profiles',()=>{
  const {pcPolicyForProfile}=require('../electron/pc-profile-policy.cjs');
  const root=path.join(os.tmpdir(),'feno-policy-fixture');
  const normal=pcPolicyForProfile({kind:'production',coreHome:path.join(root,'normal'),userData:path.join(root,'normal-ui')});
  const dev=pcPolicyForProfile({kind:'development',coreHome:path.join(root,'dev'),userData:path.join(root,'dev-ui')});
  assert.equal(normal.profileId,'pc2-normal'); assert.equal(dev.profileId,'pc2-dev');
  assert.equal(normal.defaultEnabled,false); assert.equal(dev.defaultEnabled,false);
  assert.equal(normal.defaultDurationMs,3600000); assert.equal(normal.maxDurationMs,7200000);
  assert.notEqual(normal.persistentStorePath,dev.persistentStorePath);
  assert.notEqual(normal.runtimeDirectory,dev.runtimeDirectory);
  assert.throws(()=>pcPolicyForProfile({kind:'remote',coreHome:root,userData:root}),/pc_access_denied/);
});

test('each real permission has an immutable risk explanation suitable for local approval UI',()=>{
  const {PC_PERMISSION_DETAILS}=require('../electron/pc-profile-policy.cjs');
  assert.deepEqual(Object.keys(PC_PERMISSION_DETAILS).sort(),['files.read','files.write','jobs','terminal.exec','screen.read','desktop.input','desktop.advanced','apps.launch','screen.full','adb','runner','browser'].sort());
  assert.equal(PC_PERMISSION_DETAILS['terminal.exec'].risk,'high');
  assert.equal(PC_PERMISSION_DETAILS.jobs.risk,'high');
  assert.equal(PC_PERMISSION_DETAILS['screen.full'].risk,'high');
  assert.equal(PC_PERMISSION_DETAILS['desktop.advanced'].risk,'high');
  for(const detail of Object.values(PC_PERMISSION_DETAILS)) {
    assert.ok(detail.title.length>3); assert.ok(detail.description.length>30); assert.ok(Object.isFrozen(detail));
  }
  assert.ok(Object.isFrozen(PC_PERMISSION_DETAILS));
});
test('launcher application choices have fixed IDs and cannot include shell executables',()=>{
  const {PC_ALLOWED_APPLICATIONS,validatePcSelection}=require('../electron/pc-profile-policy.cjs');
  assert.equal(PC_ALLOWED_APPLICATIONS.some(app=>app.id==='cmd.exe'),false);
  assert.equal(PC_ALLOWED_APPLICATIONS.filter(app=>app.launchable).length,3);
  assert.throws(()=>validatePcSelection({durationMs:3600000,roots:['D:\\GitHub\\fixture'],permissions:['screen.full','screen.full'],allowedApps:[]}),/pc_access_denied/);
});
test('even a misconfigured shared home cannot make normal and DEV overwrite the same PC authority files',()=>{
  const {pcPolicyForProfile}=require('../electron/pc-profile-policy.cjs');const root=path.join(os.tmpdir(),'same-pc-home');
  const normal=pcPolicyForProfile({kind:'production',coreHome:root,userData:root});
  const dev=pcPolicyForProfile({kind:'development',coreHome:root,userData:root});
  assert.notEqual(normal.runtimeDirectory,dev.runtimeDirectory);
  assert.notEqual(normal.persistentStorePath,dev.persistentStorePath);
  assert.equal(dev.legacyPersistentStorePath,path.join(root,'pc-permanent-consent.enc'));
});
