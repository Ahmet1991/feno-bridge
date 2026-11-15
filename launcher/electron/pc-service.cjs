"use strict";
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {pcPolicyForProfile,validatePcSelection,copyPcSelection,PC_ALLOWED_APPLICATIONS,PC_FULL_PERMISSIONS}=require('./pc-profile-policy.cjs');
const {getNativeSecurityContext,createPrivateFileAccess,createWindowsDpapiProtection}=require('./private-acl.cjs');
const {createPcPersistentConsent}=require('./pc-persistent-consent.cjs');
const {createPcConsentController}=require('./pc-consent.cjs');
const {createPcConsentChannel}=require('./pc-consent-channel.cjs');
const {createPcPeerRegistry}=require('./pc-resource-peers.cjs');
const {createPcHeartbeatGuard}=require('./pc-heartbeat-guard.cjs');
const {createPcDevRetirementStore}=require('./pc-dev-retirement.cjs');
const {pcRuntimePaths}=require('./pc-runtime-paths.cjs');
const deny=()=>new Error('pc_access_denied');
function listWindowsFixedDrives(){
  if(process.platform!=='win32')throw deny();
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3").DeviceID'],{encoding:'utf8',timeout:8000,windowsHide:true});
  return output.split(/\r?\n/).map(value=>value.trim()).filter(value=>/^[A-Z]:$/i.test(value)).map(value=>value.toUpperCase()+'\\');
}
function readFullFlag(configPath){
  const raw=fs.readFileSync(configPath,'utf8');
  if(Buffer.byteLength(raw)>256*1024)throw deny();
  const json=JSON.parse(raw.replace(/^\uFEFF/,''));
  if(!json||typeof json!=='object'||(json.pcFullAccess!==undefined&&typeof json.pcFullAccess!=='boolean'))throw deny();
  return json.pcFullAccess===true;
}
function disableFullFlag(configPath){
  const source=fs.readFileSync(configPath,'utf8'),bom=source.startsWith('\uFEFF')?'\uFEFF':'';
  const config=JSON.parse(source.replace(/^\uFEFF/,''));
  if(!config||config.pcFullAccess!==true)throw deny();
  config.pcFullAccess=false;
  const stage=path.join(path.dirname(configPath),'.pc-full-access-'+randomUUID()+'.tmp');
  try{
    fs.writeFileSync(stage,bom+JSON.stringify(config,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
    fs.renameSync(stage,configPath);
  }finally{try{fs.unlinkSync(stage);}catch{}}
}
function createPcLauncherService({profile,bunPath,sharedDirectory,clock=Date.now,confirmLocally,confirmRetirementLocally,audit=()=>{},testPeerEvidence,
  fullAccessConfigPath=path.join(profile.coreHome,'config.json'),listFixedDriveRoots=listWindowsFixedDrives}){
  const policy=pcPolicyForProfile(profile),layout=pcRuntimePaths({coreHome:profile.coreHome,profileId:policy.profileId,sharedDirectory});
  let channel,controller,peers,retirementStore,scope,timer,guard,lastAutoStop,started=false,initialized=false,stopped=false,retirementPending=false;
  let lastConfigErrorAt=-Infinity;
  const blank=()=>({roots:[],permissions:[],allowedApps:[]});
  function enabledInConfig(){
    if(policy.profileId!=='pc2-normal')return false;
    try{return readFullFlag(fullAccessConfigPath);}catch(error){if(error?.code==='ENOENT')return false;throw error;}
  }
  function issueFullGrant(){
    const roots=[...new Set(listFixedDriveRoots().map(root=>root.toUpperCase()))].sort();
    if(!roots.length||!roots.every(root=>/^[A-Z]:\\$/.test(root)))throw deny();
    const selection={durationMs:null,fullAccess:true,roots,permissions:[...PC_FULL_PERMISSIONS],allowedApps:[]};
    validatePcSelection(selection);
    const grant=controller.activateFullAccess(selection);
    try{channel.activate(grant);scope=copyPcSelection(selection);}catch(error){controller.suspend();scope=undefined;throw error;}
  }
  function reconcileFullAccess(){
    if(policy.profileId!=='pc2-normal')return;
    let configured=false;
    try{configured=enabledInConfig();}catch(error){
      // A temporary sharing violation must not silently revoke an existing grant.
      if(['EPERM','EBUSY','EAGAIN','ETIMEDOUT'].includes(error?.code)){
        if(clock()-lastConfigErrorAt>=10000){lastConfigErrorAt=clock();audit({action:'full_access_config_retry',at:clock(),code:'pc_private_storage_transient'});}
        return;
      }
      // Malformed configuration and other security errors never authorize access.
    }
    if(configured){
      if(!controller.status().enabled||scope?.fullAccess!==true){
        try{issueFullGrant();}catch(error){audit({action:'full_access_recovery_failed',at:clock(),code:'pc_access_denied'});}
      }
    }else if(scope?.fullAccess){
      scope=undefined;try{controller.revoke();}finally{channel.revoke();}
      audit({action:'full_access_disabled',at:clock()});
    }
  }
  function heartbeat(){
    if(!started)return;
    reconcileFullAccess();
    guard.heartbeat();
  }
  const service={
    start(){
      if(initialized)throw deny();initialized=true;
      const context=getNativeSecurityContext({bunPath}),files=createPrivateFileAccess(context.userSid,{bunPath});
      // Only new, separate security directories are created. Existing insecure ones are rejected.
      if(!fs.existsSync(path.join(profile.coreHome,'runtime')))files.ensurePrivateDirectory(path.join(profile.coreHome,'runtime'));
      files.ensurePrivateDirectory(layout.directory);
      files.ensurePrivateDirectory(path.join(profile.userData,'pc-control'));
      files.ensurePrivateDirectory(path.dirname(policy.persistentStorePath));
      channel=createPcConsentChannel({directory:layout.directory,profileId:policy.profileId,files,clock});channel.start();
      const store=createPcPersistentConsent({filePath:policy.persistentStorePath,profileId:policy.profileId,files,
        encryption:createWindowsDpapiProtection(context.userSid,policy.profileId,{bunPath})});
      controller=createPcConsentController({profileId:policy.profileId,clock,confirmLocally,
        audit:event=>{
          if(event.action==='expired'||event.action==='invalid_clock')lastAutoStop={at:event.at,reason:event.action,code:'pc_access_denied'};
          audit(event);
        },store});
      if(policy.profileId==='pc2-normal')retirementStore=createPcDevRetirementStore({directory:layout.sharedDirectory,files,
        encryption:createWindowsDpapiProtection(context.userSid,'pc2-normal',{bunPath})});
      peers=createPcPeerRegistry({directory:layout.sharedDirectory,files,legacyHomes:layout.legacyHomes,devInstallPaths:layout.devInstallPaths,retirementStore,clock,
        ...(testPeerEvidence?{inspectDevLaunchers:testPeerEvidence.inspectDevLaunchers,devInstallPaths:testPeerEvidence.devInstallPaths||layout.devInstallPaths,
          legacyHomes:{...layout.legacyHomes,'pc2-dev':testPeerEvidence.devHome||layout.legacyHomes['pc2-dev']}}:{}),
      });
      peers.start(policy.profileId);
      guard=createPcHeartbeatGuard({clock,controller,channel,peers,onInactive:()=>{scope=undefined;},audit:event=>{
        if(event.action==='auto_suspended')lastAutoStop={at:event.at,reason:event.reason,code:event.code};
        audit(event);
      }});
      const saved=store.restore();
      if(saved&&!saved.fullAccess&&!enabledInConfig()){
        const appsValid=saved.allowedApps.every(app=>PC_ALLOWED_APPLICATIONS.some(item=>item.id===app));
        const launchValid=!saved.permissions.includes('apps.launch')||saved.allowedApps.some(app=>PC_ALLOWED_APPLICATIONS.some(item=>item.id===app&&item.launchable));
        if(appsValid&&launchValid){const grant=controller.restoreTrustedPersistentSelection(saved);channel.activate(grant);scope=copyPcSelection(saved);}
      }
      started=true;reconcileFullAccess();timer=setInterval(heartbeat,2000);timer.unref?.();
    },
    status(){
      const state=controller?.status()||{enabled:false};
      const guardState=guard?.status();
      let dev;
      if(started&&guardState?.coordinationReady)try{dev=peers.observe().peers.find(p=>p.profileId==='pc2-dev');}catch{}
      const devMode=dev?.reason==='not-installed'?'not-installed':dev?.reason==='retired'?'retired':dev?.reason==='running'?'running':dev?.verified&&dev.protocol==='pc-host-control-v1'?'compatible':'unverified';
      return {...state,profileId:policy.profileId,permissionDetails:policy.permissionDetails,applicationCatalog:PC_ALLOWED_APPLICATIONS,
        fullAccess:state.enabled===true&&scope?.fullAccess===true,
        coordinationReady:guardState?.coordinationReady===true,lastAutoStop,
        devMode,devRetired:retirementStore?.read()===true,
        ...(state.enabled&&scope?{roots:[...scope.roots],permissions:[...scope.permissions],allowedApps:[...scope.allowedApps]}:blank()),
        available:started};
    },
    async setDevRetired(retired){
      if(!started||policy.profileId!=='pc2-normal'||typeof retired!=='boolean'||!retirementStore
        ||retirementPending||typeof confirmRetirementLocally!=='function')throw deny();
      retirementPending=true;
      try{
        if(!peers.canRetireDev())throw deny();
        if(await confirmRetirementLocally(retired)!==true)throw deny();
        if(!started||stopped||!peers.canRetireDev())throw deny();
        retirementStore.set(retired);
        return service.status();
      }finally{retirementPending=false;}
    },
    async approve(selection){
      if(!started||scope?.fullAccess||enabledInConfig())throw deny();validatePcSelection(selection);selection=copyPcSelection(selection);
      if(selection.roots.length!==1||selection.allowedApps.some(app=>!PC_ALLOWED_APPLICATIONS.some(item=>item.id===app))
        ||(selection.allowedApps.length>0&&!selection.permissions.some(p=>['screen.read','desktop.input','apps.launch'].includes(p)))
        ||(selection.permissions.includes('desktop.advanced')&&!selection.permissions.includes('desktop.input'))
        ||(selection.permissions.some(p=>['screen.read','desktop.input','apps.launch'].includes(p))&&!selection.allowedApps.length)
        ||(selection.permissions.includes('apps.launch')&&!selection.allowedApps.some(app=>PC_ALLOWED_APPLICATIONS.some(item=>item.id===app&&item.launchable))))throw deny();
      const root=fs.realpathSync.native(selection.roots[0]);if(!fs.statSync(root).isDirectory())throw deny();selection.roots=[root];validatePcSelection(selection);
      // Replacing scopes retires transport before a dialog or asynchronous activation can run.
      service.revoke();
      const grant=await controller.approve(selection);
      try{
        // A revoke may land after the approval promise resolves but before this continuation.
        if(!started||stopped||!controller.isActiveGrant(grant.id))throw deny();
        channel.activate(grant);scope=copyPcSelection(selection);return service.status();
      }
      catch{try{controller.revoke();}finally{scope=undefined;channel.revoke();}throw deny();}
    },
    revoke(){
      if(!controller||enabledInConfig())throw deny();scope=undefined;
      try{controller.revoke();}finally{channel.revoke();}
      return service.status();
    },
    disableFullAccess(){
      if(!started||policy.profileId!=='pc2-normal'||!enabledInConfig())throw deny();
      disableFullFlag(fullAccessConfigPath);
      scope=undefined;
      try{controller.revoke();}finally{channel.revoke();}
      audit({action:'full_access_disabled',at:clock()});return service.status();
    },
    heartbeat,
    assertCanExit(){if(controller?.status().persistentRevocationPending)throw new Error('pc_persistent_revocation_pending');},
    suspend(){
      if(stopped)return;stopped=true;
      if(timer)clearInterval(timer);timer=undefined;scope=undefined;started=false;
      controller?.suspend();try{channel?.revoke();}finally{peers?.close();}
    },
  };
  return service;
}
function registerPcIpc({register,getMainWindow,rendererNavigationAllowed,getService,dialog}){
  const trusted=event=>{
    const win=getMainWindow();
    if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame
      ||!event.senderFrame||!rendererNavigationAllowed(event.senderFrame.url))throw deny();return win;
  };
  register('launcher:pc-status',event=>{trusted(event);return getService()?.status()||{enabled:false,available:false,roots:[],permissions:[],allowedApps:[]};});
  register('launcher:pc-pick-root',async event=>{const win=trusted(event);if(process.platform!=='win32')throw deny();const r=await dialog.showOpenDialog(win,{title:'PC denetimi için proje seç',properties:['openDirectory']});return r.canceled?null:r.filePaths[0]||null;});
  register('launcher:pc-approve',async(event,selection)=>{trusted(event);const service=getService();if(!service)throw deny();return service.approve(selection);});
  register('launcher:pc-revoke',event=>{trusted(event);const service=getService();if(!service)throw deny();return service.revoke();});
  register('launcher:pc-disable-full',event=>{trusted(event);const service=getService();if(!service)throw deny();return service.disableFullAccess();});
  register('launcher:pc-retire-dev',(event,retired)=>{trusted(event);const service=getService();if(!service)throw deny();return service.setDevRetired(retired);});
}
module.exports={createPcLauncherService,registerPcIpc};
