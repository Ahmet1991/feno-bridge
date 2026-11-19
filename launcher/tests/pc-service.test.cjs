const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const windowsTest=(name,fn)=>test(name,{skip:process.platform!=='win32'},fn);
const bunPath=process.platform==='win32'?cp.spawnSync('bun',['--print','process.execPath'],{encoding:'utf8'}).stdout.trim():'';
function fixture(kind='production',clock=Date.now,confirmLocally=async()=>true,audit=()=>{}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pc-service-test-'));
  for(const name of ['home','ui','project'])fs.mkdirSync(path.join(root,name));
  const {createPcLauncherService}=require('../electron/pc-service.cjs');
  const profile={kind,coreHome:path.join(root,'home'),userData:path.join(root,'ui')};
  const service=createPcLauncherService({profile,bunPath,sharedDirectory:path.join(root,'coord'),clock,confirmLocally,audit});
  service.start();return {root,profile,service,selection:{durationMs:60000,roots:[path.join(root,'project')],permissions:['files.read','files.write','jobs','terminal.exec'],allowedApps:[]}};
}
windowsTest('normal launcher starts denied, local approval binds its profile, and expiry clears transport',async()=>{
  let now=1000;const f=fixture('production',()=>now);try{
    assert.equal(f.service.status().enabled,false);assert.equal(f.service.status().profileId,'pc2-normal');
    await f.service.approve(f.selection);assert.equal(f.service.status().enabled,true);
    assert.deepEqual(f.service.status().permissions,f.selection.permissions);
    assert.equal(f.service.status().permissionDetails['terminal.exec'].risk,'high');
    now=61000;await f.service.heartbeat();assert.equal(f.service.status().enabled,false);
    assert.equal(f.service.readTransportForTest,undefined);
  }finally{f.service.suspend();}
});
windowsTest('perpetual normal approval restores only its own encrypted record and revoke survives a fresh service',async()=>{
  const f=fixture();try{
    await f.service.approve({...f.selection,durationMs:null});f.service.suspend();
    const {createPcLauncherService}=require('../electron/pc-service.cjs');
    const restored=createPcLauncherService({profile:f.profile,bunPath,sharedDirectory:path.join(f.root,'coord'),confirmLocally:async()=>false});
    restored.start();assert.equal(restored.status().enabled,true);assert.equal(restored.status().expiresAt,null);
    restored.revoke();restored.suspend();
    const next=createPcLauncherService({profile:f.profile,bunPath,sharedDirectory:path.join(f.root,'coord'),confirmLocally:async()=>false});
    next.start();assert.equal(next.status().enabled,false);next.suspend();
  }finally{f.service.suspend();}
});
windowsTest('revoking an in-flight local dialog prevents stale activation',async()=>{
  let finish;const f=fixture('production',Date.now,()=>new Promise(r=>finish=r));
  try{const pending=f.service.approve(f.selection);f.service.revoke();finish(true);await assert.rejects(pending);assert.equal(f.service.status().enabled,false);}
  finally{f.service.suspend();}
});
windowsTest('a revoke during completed approval cannot resurrect the signed MCP grant',async()=>{
  let service;
  const f=fixture('production',Date.now,async()=>true,({action})=>{if(action==='approved')queueMicrotask(()=>service.revoke());});
  service=f.service;
  try{
    await assert.rejects(service.approve(f.selection),/pc_access_denied/);
    assert.equal(service.status().enabled,false);
    const state=JSON.parse(fs.readFileSync(path.join(f.profile.coreHome,'runtime','pc2-normal','pc-consent-state.json'),'utf8'));
    assert.equal(state.payload.grant,null);
  }finally{service.suspend();}
});
test('PC IPC rejects another renderer and a same-origin subframe before any approval',async()=>{
  const {registerPcIpc}=require('../electron/pc-service.cjs');const handlers=new Map();let approved=0;
  const frame={url:'file:///trusted/index.html'},webContents={mainFrame:frame},window={webContents,isDestroyed:()=>false};
  registerPcIpc({register:(name,fn)=>handlers.set(name,fn),getMainWindow:()=>window,rendererNavigationAllowed:url=>url===frame.url,
    getService:()=>({approve:async()=>{approved++;return{};},status:()=>({enabled:false})}),dialog:{}});
  const approve=handlers.get('launcher:pc-approve');
  await assert.rejects(async()=>approve({sender:{},senderFrame:frame},{}),/pc_access_denied/);
  await assert.rejects(async()=>approve({sender:webContents,senderFrame:{url:frame.url}},{}),/pc_access_denied/);
  assert.equal(approved,0);
});

windowsTest('existing runtime parent ACL is not migrated when creating a new private profile directory',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pc-existing-runtime-'));
  const profile={kind:'production',coreHome:path.join(root,'home'),userData:path.join(root,'ui')};
  fs.mkdirSync(profile.coreHome);fs.mkdirSync(profile.userData);fs.mkdirSync(path.join(profile.coreHome,'runtime'));
  const {createPcLauncherService}=require('../electron/pc-service.cjs');
  const service=createPcLauncherService({profile,bunPath,sharedDirectory:path.join(root,'coord'),confirmLocally:async()=>true});
  try{service.start();assert.equal(service.status().available,true);assert.equal(service.status().enabled,false);}
  finally{service.suspend();}
});
windowsTest('DEV retirement needs local confirmation, is reversible and never overrides a running DEV',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pc-retirement-service-'));
  for(const folder of ['home','ui','dev'])fs.mkdirSync(path.join(root,folder));
  const {createPcLauncherService}=require('../electron/pc-service.cjs');
  let live=false,approved=true,confirmed=0;
  const service=createPcLauncherService({
    profile:{kind:'production',coreHome:path.join(root,'home'),userData:path.join(root,'ui')},
    bunPath,sharedDirectory:path.join(root,'coord'),confirmLocally:async()=>true,
    confirmRetirementLocally:async()=>{confirmed++;return approved;},
    testPeerEvidence:{devHome:path.join(root,'dev'),devInstallPaths:[path.join(root,'no-install')],
      inspectDevLaunchers:()=>live?{state:'alive',pids:[process.pid]}:{state:'absent',pids:[]}},
  });
  service.start();try{
    assert.equal(service.status().devMode,'unverified');
    approved=false;await assert.rejects(service.setDevRetired(true),/pc_access_denied/);
    assert.equal(service.status().devRetired,false);
    approved=true;await service.setDevRetired(true);
    assert.equal(service.status().devMode,'retired');
    live=true;assert.equal(service.status().devMode,'running');
    await assert.rejects(service.setDevRetired(false),/pc_access_denied/);
    assert.equal(service.status().devRetired,true);
    live=false;await service.setDevRetired(false);
    assert.equal(service.status().devMode,'unverified');
    assert.equal(service.status().devRetired,false);
    assert.equal(confirmed,3);
  }finally{service.suspend();}
});

test('retirement IPC is restricted to the trusted main frame; MCP has no retirement tool',async()=>{
  const {registerPcIpc}=require('../electron/pc-service.cjs');
  const handlers=new Map();const frame={url:'file:///trusted/index.html'};
  const webContents={mainFrame:frame},win={webContents,isDestroyed:()=>false};let writes=0;
  registerPcIpc({register:(name,fn)=>handlers.set(name,fn),getMainWindow:()=>win,
    rendererNavigationAllowed:url=>url===frame.url,getService:()=>({setDevRetired:async()=>{writes++;return{};}}),dialog:{}});
  const retire=handlers.get('launcher:pc-retire-dev');
  await assert.rejects(async()=>retire({sender:{},senderFrame:frame},true),/pc_access_denied/);
  await assert.rejects(async()=>retire({sender:webContents,senderFrame:{url:frame.url}},true),/pc_access_denied/);
  assert.equal(writes,0);
  await retire({sender:webContents,senderFrame:frame},true);
  assert.equal(writes,1);
});
