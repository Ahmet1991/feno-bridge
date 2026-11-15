const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {createPcLauncherService}=require('../electron/pc-service.cjs');
const windowsTest=(name,run)=>test(name,{skip:process.platform!=='win32'},run);
const bunPath=process.platform==='win32'?cp.spawnSync('bun',['--print','process.execPath'],{encoding:'utf8'}).stdout.trim():'';
function fixture(enabled=true,kind='production'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pc-full-access-'));
  const profile={kind,coreHome:path.join(root,'home'),userData:path.join(root,'ui')};
  fs.mkdirSync(profile.coreHome);fs.mkdirSync(profile.userData);
  const configPath=path.join(profile.coreHome,'config.json');
  fs.writeFileSync(configPath,JSON.stringify({version:3,pcFullAccess:enabled,appName:'Test'}));
  let confirms=0;const actions=[];
  const make=()=>createPcLauncherService({profile,bunPath,sharedDirectory:path.join(root,'coord'),
    confirmLocally:async()=>{confirms++;return true;},fullAccessConfigPath:configPath,
    listFixedDriveRoots:()=>['C:\\','D:\\'],audit:e=>actions.push(e)});
  return {root,profile,configPath,make,actions,get confirms(){return confirms;}};
}
windowsTest('explicit normal config starts full grant without local dialog, persists across restart and rejects DEV',()=>{
  const f=fixture();const a=f.make();try{
    a.start();assert.equal(a.status().enabled,true);assert.equal(a.status().fullAccess,true);
    assert.equal(a.status().expiresAt,null);assert.equal(f.confirms,0);
    assert.deepEqual(a.status().roots,['C:\\','D:\\']);
    assert.equal(a.status().permissions.length,11);assert.deepEqual(a.status().allowedApps,[]);
    const signed=JSON.parse(fs.readFileSync(path.join(f.profile.coreHome,'runtime','pc2-normal','pc-consent-state.json'),'utf8'));
    assert.equal(signed.payload.grant.fullAccess,true);assert.ok(signed.signature);
    a.suspend();const restarted=f.make();restarted.start();try{assert.equal(restarted.status().enabled,true);assert.equal(f.confirms,0);}finally{restarted.suspend();}
    assert.ok(f.actions.some(e=>e.action==='full_access_enabled'));
  }finally{a.suspend();}
});
windowsTest('corrupt signed transport is reissued from explicit flag and tampered saved receipt is not trusted',()=>{
  const f=fixture(),a=f.make();try{
    a.start();const state=path.join(f.profile.coreHome,'runtime','pc2-normal','pc-consent-state.json');
    fs.writeFileSync(state,'{tampered');a.heartbeat();
    const repaired=JSON.parse(fs.readFileSync(state,'utf8'));
    assert.equal(repaired.payload.grant.fullAccess,true);
    const encrypted=path.join(f.profile.userData,'pc-control','pc2-normal','pc-permanent-consent.enc');
    a.suspend();fs.writeFileSync(encrypted,'tampered');const next=f.make();next.start();try{assert.equal(next.status().enabled,true);}finally{next.suspend();}
  }finally{a.suspend();}
});
windowsTest('full mode can be disabled from settings and old selective approval remains intact',async()=>{
  const f=fixture(),a=f.make();try{
    a.start();assert.equal(a.status().fullAccess,true);
    const disabled=a.disableFullAccess();assert.equal(disabled.enabled,false);
    assert.equal(disabled.fullAccess,false);assert.equal(JSON.parse(fs.readFileSync(f.configPath)).pcFullAccess,false);
    a.suspend();const next=f.make();next.start();try{
      assert.equal(next.status().enabled,false);
      const project=path.join(f.root,'project');fs.mkdirSync(project);
      await next.approve({durationMs:60000,roots:[project],permissions:['files.read'],allowedApps:[]});
      assert.equal(next.status().enabled,true);assert.equal(next.status().fullAccess,false);assert.equal(f.confirms,1);
    }finally{next.suspend();}
    assert.ok(f.actions.some(e=>e.action==='full_access_disabled'));
  }finally{a.suspend();}
});
test('disable full mode IPC requires the same trusted main frame',()=>{
  const {registerPcIpc}=require('../electron/pc-service.cjs');const handlers=new Map();let disabled=0;
  const frame={url:'file:///trusted/index.html'},webContents={mainFrame:frame},win={webContents,isDestroyed:()=>false};
  registerPcIpc({register:(name,fn)=>handlers.set(name,fn),getMainWindow:()=>win,rendererNavigationAllowed:url=>url===frame.url,
    getService:()=>({disableFullAccess:()=>{disabled++;return{};}}),dialog:{}});
  assert.throws(()=>handlers.get('launcher:pc-disable-full')({sender:{},senderFrame:frame}),/pc_access_denied/);
  assert.equal(disabled,0);
  handlers.get('launcher:pc-disable-full')({sender:webContents,senderFrame:frame});assert.equal(disabled,1);
});
windowsTest('DEV profile ignores pcFullAccess even when the DEV config contains it',()=>{
  const f=fixture(true,'development'),service=f.make();
  try{service.start();assert.equal(service.status().enabled,false);assert.equal(service.status().fullAccess,false);assert.equal(f.confirms,0);}
  finally{service.suspend();}
});
