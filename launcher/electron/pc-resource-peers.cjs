"use strict";
const fs=require('node:fs'),path=require('node:path');
const PROTOCOL='pc-host-control-v1',PROFILES=['pc2-normal','pc2-dev'];
function createPcPeerRegistry({directory,files,inspectProcess=files.inspectProcess,inspectDevLaunchers=files.inspectDevLauncherProcesses,retirementStore,legacyHomes={},devInstallPaths=[],clock=Date.now}){
  if(!path.isAbsolute(directory)||typeof inspectProcess!=='function')throw Error('pc_access_denied');
  let own;
  const target=id=>path.join(directory,id+'.json');
  const unknown=profileId=>({profileId,verified:false,state:'unknown'});
  function statIfPresent(p){
    try{return fs.lstatSync(p);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  function devProcessEvidence(){
    try{
      const result=inspectDevLaunchers?.();
      if(result?.state==='absent'&&Array.isArray(result.pids)&&result.pids.length===0)return result;
      if(result?.state==='alive'&&Array.isArray(result.pids)&&result.pids.length>0
        &&result.pids.every(p=>Number.isInteger(p)&&p>0))return result;
    }catch{}
    return {state:'unknown',pids:[]};
  }
  function noDevHome(){
    const home=legacyHomes['pc2-dev'];
    if(typeof home!=='string'||!path.isAbsolute(home))return false;
    try{fs.lstatSync(home);return false;}
    catch(error){if(error.code==='ENOENT')return true;return false;}
  }
  function noDevInstallation(){
    if(!Array.isArray(devInstallPaths)||devInstallPaths.length===0)return false;
    try{
      for(const candidate of devInstallPaths){
        if(typeof candidate!=='string'||!path.isAbsolute(candidate))return false;
        try{fs.lstatSync(candidate);return false;}
        catch(error){if(error.code!=='ENOENT')return false;}
      }
      return true;
    }catch{return false;}
  }
  function legacyDevIsQuiet(){
    const home=legacyHomes['pc2-dev'];
    if(typeof home!=='string'||!path.isAbsolute(home))return false;
    try{
      const descriptor=path.join(home,'runtime','launcher-browser.json');
      const stat=statIfPresent(descriptor);
      if(!stat)return true;
      if(!stat.isFile()||stat.size>32768)return false;
      const value=JSON.parse(fs.readFileSync(descriptor,'utf8'));
      if(!Number.isInteger(value.pid)||value.pid<1)return false;
      return inspectProcess(value.pid).state==='dead';
    }catch{return false;}
  }
  function canRetireDev(){
    if(devProcessEvidence().state!=='absent'||!legacyDevIsQuiet())return false;
    try{
      const file=target('pc2-dev');
      const stat=statIfPresent(file);
      if(!stat)return true;
      if(!stat.isFile()||stat.size>8192)return false;
      const record=JSON.parse(files.readPrivateFile(file,8192).toString('utf8'));
      if(!Number.isInteger(record.pid)||record.pid<1)return false;
      return inspectProcess(record.pid).state==='dead';
    }catch{return false;}
  }
  function devFallback(processes){
    if(processes.state==='alive')return {...unknown('pc2-dev'),reason:'running'};
    if(processes.state!=='absent')return unknown('pc2-dev');
    const home=legacyHomes['pc2-dev'];
    if(home){
      try{
        const descriptor=path.join(home,'runtime','launcher-browser.json');
        const stat=statIfPresent(descriptor);
        if(stat){
          if(!stat.isFile()||stat.size>32768)return unknown('pc2-dev');
          const legacy=JSON.parse(fs.readFileSync(descriptor,'utf8'));
          if(!Number.isInteger(legacy.pid)||legacy.pid<1)return unknown('pc2-dev');
          const actual=inspectProcess(legacy.pid);
          if(actual.state==='alive')return {...unknown('pc2-dev'),reason:'running'};
          if(actual.state!=='dead')return unknown('pc2-dev');
        }
      }catch{return unknown('pc2-dev');}
    }
    if(noDevHome()&&noDevInstallation())return {profileId:'pc2-dev',verified:true,state:'inactive',reason:'not-installed'};
    if(retirementStore?.read()===true)return {profileId:'pc2-dev',verified:true,state:'inactive',reason:'retired'};
    return unknown('pc2-dev');
  }
  function publish(state){
    if(!own)throw Error('pc_access_denied');
    files.writePrivateAtomic(target(own.profileId),JSON.stringify({...own,state,heartbeatAt:clock()}));
  }
  async function publishAsync(state){
    if(!own)throw Error('pc_access_denied');
    const targetPath=target(own.profileId),value=JSON.stringify({...own,state,heartbeatAt:clock()});
    if(typeof files.writePrivateAtomicAsync==='function')await files.writePrivateAtomicAsync(targetPath,value);
    else files.writePrivateAtomic(targetPath,value);
  }
  return {
    canRetireDev,
    start(profileId){
      if(!PROFILES.includes(profileId)||own)throw Error('pc_access_denied');
      files.ensurePrivateDirectory(directory);const self=inspectProcess(process.pid);
      if(self.state!=='alive'||!self.startTime)throw Error('pc_access_denied');
      own={schema:1,protocol:PROTOCOL,profileId,pid:process.pid,startTime:self.startTime};publish('active');
    },
    heartbeat(){if(own)publish('active');},
    async heartbeatAsync(){if(own)await publishAsync('active');},
    close(){if(own){try{publish('inactive');}finally{own=undefined;}}},
    observe(){
      const now=clock(),devProcesses=devProcessEvidence();
      const peers=PROFILES.map(profileId=>{
        try{
          const record=JSON.parse(files.readPrivateFile(target(profileId),8192).toString('utf8'));
          if(record.schema!==1||record.profileId!==profileId||record.protocol!==PROTOCOL||!Number.isInteger(record.pid)||record.pid<1
            ||typeof record.startTime!=='string'||!/^\d{1,24}$/.test(record.startTime)||!['active','inactive'].includes(record.state))return profileId==='pc2-dev'?devFallback(devProcesses):unknown(profileId);
          if(profileId==='pc2-dev'&&(devProcesses.state==='unknown'
            ||(record.state==='active'&&devProcesses.state!=='alive')
            ||(devProcesses.state==='alive'&&!devProcesses.pids.includes(record.pid))))return devFallback(devProcesses);
          const actual=inspectProcess(record.pid);
          // A configured legacy launcher must never be hidden by an old compatible record.
          const home=legacyHomes[profileId];
          if(home){
            const descriptor=path.join(home,'runtime','launcher-browser.json');
            const stat=statIfPresent(descriptor);
            if(stat){
              if(!stat.isFile()||stat.size>32768)return unknown(profileId);
              const old=JSON.parse(fs.readFileSync(descriptor,'utf8'));
              if(!Number.isInteger(old.pid)||old.pid<1)return unknown(profileId);
              const legacy=inspectProcess(old.pid);
              if(legacy.state==='unknown'||(legacy.state==='alive'&&(old.pid!==record.pid||legacy.startTime!==record.startTime)))return unknown(profileId);
            }
          }
          if(actual.state==='dead'||(actual.state==='alive'&&actual.startTime&&actual.startTime!==record.startTime))
            return {profileId,verified:true,state:'inactive',protocol:PROTOCOL};
          if(actual.state!=='alive'||record.state!=='active'||!Number.isFinite(now)||!Number.isSafeInteger(record.heartbeatAt)
            ||record.heartbeatAt>now+2000||now-record.heartbeatAt>10000)return unknown(profileId);
          return {profileId,verified:true,state:'active',protocol:PROTOCOL};
        }catch{return profileId==='pc2-dev'?devFallback(devProcesses):unknown(profileId);}
      });
      return {complete:peers.every(p=>p.verified),peers};
    },
  };
}
module.exports={createPcPeerRegistry};
