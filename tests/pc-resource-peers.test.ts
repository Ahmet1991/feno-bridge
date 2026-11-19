import {afterAll,test,expect} from 'bun:test';
import {mkdirSync,writeFileSync} from 'node:fs';
import { trackTempDirectories } from './support/temp-directories';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPcPeerRegistry} from '../src/pc-control/resource-peers';
import {assertCompatiblePcResourcePeers} from '../src/pc-control/resource-protocol';

const mkdtempSync = trackTempDirectories(afterAll);
const windowsTest=process.platform==='win32'?test:test.skip;
windowsTest('a machine with no DEV home or peer permits a normal single-profile job lease',()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-no-dev-'));
  const native=require('../launcher/electron/private-acl-native.cjs');
  const {createPrivateFileAccess}=require('../launcher/electron/private-acl.cjs');
  const files=createPrivateFileAccess(native.getCurrentUserSid());
  const registry=createPcPeerRegistry({directory:join(root,'coord'),files,legacyHomes:{'pc2-dev':join(root,'not-installed')},
    inspectProcess:native.inspectProcess,inspectDevLaunchers:()=>({state:'absent',pids:[]}),devInstallPaths:[join(root,'no-install')]});
  registry.start('pc2-normal');
  try{expect(()=>assertCompatiblePcResourcePeers(registry.observe())).not.toThrow();
    expect(registry.observe().peers.find(p=>p.profileId==='pc2-dev')).toMatchObject({verified:true,state:'inactive',reason:'not-installed'});
  }finally{registry.close();}
});
windowsTest('missing, invalid and legacy peer evidence never becomes inactive merely by absence',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-peer-test-'));const home=join(root,'dev');mkdirSync(home);mkdirSync(join(home,'runtime'));
  const native=require('../launcher/electron/private-acl-native.cjs');
  const {createPrivateFileAccess}=require('../launcher/electron/private-acl.cjs');const files=createPrivateFileAccess(native.getCurrentUserSid());
  const registry=createPcPeerRegistry({directory:join(root,'private'),files,inspectProcess:native.inspectProcess,legacyHomes:{'pc2-dev':home},
    inspectDevLaunchers:()=>({state:'absent',pids:[]}),devInstallPaths:[join(root,'no-install')]});
  registry.start('pc2-normal');
  try {
    expect(registry.observe().complete).toBe(false);
    const child=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/pc-core-peer.ts'),join(root,'private')],{stdout:'pipe',stderr:'pipe'});
    try {
      expect(await child.exited).toBe(0);expect(registry.observe().complete).toBe(true);
      writeFileSync(join(home,'runtime/launcher-browser.json'),JSON.stringify({pid:process.pid}));
      expect(registry.observe().peers.find(p=>p.profileId==='pc2-dev')?.state).toBe('unknown');
    } finally {if(child.exitCode===null)child.kill();await child.exited;}
  } finally {registry.close();}
});
function fixture({home=false,retired=false,devProcess='absent',installation=false}: {
  home?:boolean;retired?:boolean;devProcess?:string;installation?:boolean;
}={}){
  const root=mkdtempSync(join(tmpdir(),'pc-dev-peer-unit-'));
  const devHome=join(root,'dev');const install=join(root,'dev-install');
  if(home)mkdirSync(devHome);
  if(installation)mkdirSync(install);
  const native=require('../launcher/electron/private-acl-native.cjs');
  const files=require('../launcher/electron/private-acl.cjs').createPrivateFileAccess(native.getCurrentUserSid());
  let processState=devProcess;
  const inspectDevLaunchers=()=>processState==='alive'?{state:'alive',pids:[process.pid]}:{state:processState,pids:[]};
  const options={directory:join(root,'coord'),files,inspectProcess:native.inspectProcess,inspectDevLaunchers,
    legacyHomes:{'pc2-dev':devHome},devInstallPaths:[install],retirementStore:{read:()=>retired}};
  const registry=createPcPeerRegistry(options);registry.start('pc2-normal');
  return {root,devHome,install,files,registry,options,setDevProcess:(value:string)=>{processState=value;},
    dev:()=>registry.observe().peers.find((p:{profileId:string})=>p.profileId==='pc2-dev')};
}
windowsTest('no DEV home, installation or live process permits standalone normal job lease',()=>{
  const f=fixture();try{
    expect(f.dev()).toMatchObject({verified:true,state:'inactive',reason:'not-installed'});
    expect(()=>assertCompatiblePcResourcePeers(f.registry.observe())).not.toThrow();
  }finally{f.registry.close();}
});
windowsTest('a stopped legacy DEV home or install still denies without retirement consent',()=>{
  for(const setup of [{home:true},{installation:true}]){
    const f=fixture(setup);try{
      expect(f.dev()).toMatchObject({verified:false,state:'unknown'});
      expect(()=>assertCompatiblePcResourcePeers(f.registry.observe())).toThrow('pc_resource_coordination_required');
    }finally{f.registry.close();}
  }
});
windowsTest('locally verified retired DEV home permits standalone normal execution',()=>{
  const f=fixture({home:true,retired:true});try{
    expect(f.dev()).toMatchObject({verified:true,state:'inactive',reason:'retired'});
    expect(f.registry.canRetireDev()).toBe(true);
    expect(()=>assertCompatiblePcResourcePeers(f.registry.observe())).not.toThrow();
  }finally{f.registry.close();}
});
windowsTest('live DEV overrides retirement and denies new work, including appearing mid-lease',()=>{
  const f=fixture({home:true,retired:true});try{
    expect(()=>assertCompatiblePcResourcePeers(f.registry.observe())).not.toThrow();
    f.setDevProcess('alive');expect(f.dev()).toMatchObject({verified:false,state:'unknown',reason:'running'});
    expect(f.registry.canRetireDev()).toBe(false);
    expect(()=>assertCompatiblePcResourcePeers(f.registry.observe())).toThrow('pc_resource_coordination_required');
  }finally{f.registry.close();}
});
windowsTest('unknown process result and live legacy descriptor cannot be retired',()=>{
  const f=fixture({home:true,retired:true,devProcess:'unknown'});try{
    expect(f.dev()?.verified).toBe(false);expect(f.registry.canRetireDev()).toBe(false);
    f.setDevProcess('absent');mkdirSync(join(f.devHome,'runtime'));
    writeFileSync(join(f.devHome,'runtime','launcher-browser.json'),JSON.stringify({pid:process.pid}));
    expect(f.dev()?.state).toBe('unknown');expect(f.registry.canRetireDev()).toBe(false);
  }finally{f.registry.close();}
});
windowsTest('a compatible DEV record keeps the existing dual-profile protocol',()=>{
  const f=fixture({home:true});
  const dev=createPcPeerRegistry({...f.options,inspectDevLaunchers:()=>({state:'alive',pids:[process.pid]})});
  try{dev.start('pc2-dev');f.setDevProcess('alive');
    expect(f.dev()).toMatchObject({verified:true,state:'active',protocol:'pc-host-control-v1'});
    expect(()=>assertCompatiblePcResourcePeers(f.registry.observe())).not.toThrow();
  }finally{dev.close();f.registry.close();}
});
windowsTest('native DEV process scan returns a structured fail-closed observation',()=>{
  const native=require('../launcher/electron/private-acl-native.cjs');
  const result=native.inspectDevLauncherProcesses();
  expect(['alive','absent','unknown']).toContain(result.state);
  expect(Array.isArray(result.pids)).toBe(true);
});
windowsTest('malformed legacy or private DEV evidence cannot be treated as safely retired',()=>{
  const f=fixture({home:true,retired:true});try{
    mkdirSync(join(f.devHome,'runtime'));
    writeFileSync(join(f.devHome,'runtime','launcher-browser.json'),'{bad json');
    expect(f.dev()?.verified).toBe(false);expect(f.registry.canRetireDev()).toBe(false);
  }finally{f.registry.close();}
  const g=fixture({home:true,retired:true});try{
    g.files.writePrivateAtomic(join(g.root,'coord','pc2-dev.json'),Buffer.from('{bad json'));
    expect(g.registry.canRetireDev()).toBe(false);
  }finally{g.registry.close();}
});

windowsTest('portable Akentek DEV install root prevents false not-installed and permits only retirement',()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-akentek-dev-install-'));
  const localAppData=join(root,'local-app-data');mkdirSync(localAppData);
  const {pcRuntimePaths}=require('../launcher/electron/pc-runtime-paths.cjs');
  const layout=pcRuntimePaths({coreHome:join(root,'normal'),profileId:'pc2-normal',
    env:{LOCALAPPDATA:localAppData,ProgramFiles:join(root,'program-files'),
      'ProgramFiles(x86)':join(root,'program-files-x86'),CODEX_WEB_GPT_DEV_HOME:join(root,'absent-dev-home'),
      FENO_PC_COORDINATION_DIR:join(root,'coord')}});
  const native=require('../launcher/electron/private-acl-native.cjs');
  const files=require('../launcher/electron/private-acl.cjs').createPrivateFileAccess(native.getCurrentUserSid());
  let retired=false;
  const registry=createPcPeerRegistry({directory:layout.sharedDirectory,files,
    legacyHomes:layout.legacyHomes,devInstallPaths:layout.devInstallPaths,
    inspectProcess:native.inspectProcess,inspectDevLaunchers:()=>({state:'absent',pids:[]}),
    retirementStore:{read:()=>retired}});
  registry.start('pc2-normal');
  try{
    const dev=()=>registry.observe().peers.find((p:{profileId:string})=>p.profileId==='pc2-dev');
    expect(dev()).toMatchObject({verified:true,state:'inactive',reason:'not-installed'});
    const portable=join(localAppData,'Akentek-PC-Bridge-DEV');
    mkdirSync(portable);
    expect(dev()).toMatchObject({verified:false,state:'unknown'});
    expect(()=>assertCompatiblePcResourcePeers(registry.observe())).toThrow('pc_resource_coordination_required');
    mkdirSync(join(portable,'x'));
    expect(dev()).toMatchObject({verified:false,state:'unknown'});
    retired=true;
    expect(dev()).toMatchObject({verified:true,state:'inactive',reason:'retired'});
    expect(()=>assertCompatiblePcResourcePeers(registry.observe())).not.toThrow();
  }finally{registry.close();}
});

windowsTest('missing LOCALAPPDATA cannot certify no DEV installation',()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-no-localappdata-'));
  const {pcRuntimePaths}=require('../launcher/electron/pc-runtime-paths.cjs');
  const layout=pcRuntimePaths({coreHome:join(root,'normal'),profileId:'pc2-normal',
    env:{ProgramFiles:join(root,'program-files'),CODEX_WEB_GPT_DEV_HOME:join(root,'absent-dev-home'),
      FENO_PC_COORDINATION_DIR:join(root,'coord')}});
  const native=require('../launcher/electron/private-acl-native.cjs');
  const files=require('../launcher/electron/private-acl.cjs').createPrivateFileAccess(native.getCurrentUserSid());
  const registry=createPcPeerRegistry({directory:layout.sharedDirectory,files,
    legacyHomes:layout.legacyHomes,devInstallPaths:layout.devInstallPaths,
    inspectProcess:native.inspectProcess,inspectDevLaunchers:()=>({state:'absent',pids:[]})});
  registry.start('pc2-normal');
  try{
    expect(registry.observe().peers.find((p:{profileId:string})=>p.profileId==='pc2-dev'))
      .toMatchObject({verified:false,state:'unknown'});
    expect(()=>assertCompatiblePcResourcePeers(registry.observe())).toThrow('pc_resource_coordination_required');
  }finally{registry.close();}
});
