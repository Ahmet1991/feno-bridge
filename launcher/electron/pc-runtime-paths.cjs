"use strict";
const path=require('node:path'),os=require('node:os');
const {assertPcProfileId}=require('./pc-profile-policy.cjs');
function pcRuntimePaths({coreHome,profileId,sharedDirectory,env=process.env}){
  assertPcProfileId(profileId);if(!path.isAbsolute(coreHome||''))throw Error('pc_access_denied');
  const shared=sharedDirectory||env.FENO_PC_COORDINATION_DIR||path.join(env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Feno Bridge PC Coordination');
  if(!path.isAbsolute(shared))throw Error('pc_access_denied');
  const localAppData=typeof env.LOCALAPPDATA==='string'&&path.isAbsolute(env.LOCALAPPDATA)?env.LOCALAPPDATA:null;
  const programRoots=[localAppData&&path.join(localAppData,'Programs'),env.ProgramFiles,env['ProgramFiles(x86)']].filter(Boolean);
  // Without a trustworthy LOCALAPPDATA root, DEV absence cannot be established.
  // An empty list makes the peer registry fail closed rather than claim not-installed.
  const devInstallPaths=localAppData?programRoots.flatMap(root=>['Feno Bridge DEV','Feno Bridge Dev','Feno Bridge (DEV)'].map(name=>path.join(root,name))):[];
  if(localAppData)devInstallPaths.push(path.join(localAppData,'Akentek-PC-Bridge-DEV'));
  if(localAppData&&env.CODEX_WEB_GPT_DEV_INSTALL_DIR)devInstallPaths.push(env.CODEX_WEB_GPT_DEV_INSTALL_DIR);
  return Object.freeze({directory:path.join(coreHome,'runtime',profileId),sharedDirectory:shared,devInstallPaths,
    legacyHomes:{'pc2-normal':profileId==='pc2-normal'?coreHome:env.CODEX_CHATGPT_WEB_PRODUCTION_HOME||path.join(os.homedir(),'.codex-chatgpt-web'),
      'pc2-dev':profileId==='pc2-dev'?coreHome:env.CODEX_WEB_GPT_DEV_HOME||path.join(os.homedir(),'.codex-chatgpt-web-dev')}});
}
module.exports={pcRuntimePaths};
