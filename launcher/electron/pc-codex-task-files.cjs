"use strict";
const fs=require('node:fs'),path=require('node:path');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const codexTaskDirectory=runtimeDirectory=>path.join(runtimeDirectory,'codex-tasks');
const taskPath=(directory,id,name)=>{
  if(!UUID.test(id))throw Error('pc_codex_task_not_found');
  return path.join(directory,id,name);
};
const readJson=(files,target)=>JSON.parse(files.readPrivateFile(target,16384).toString('utf8'));
function readRecord(files,directory,id){
  const r=readJson(files,taskPath(directory,id,'state.json'));
  if(r.taskId!==id||typeof r.title!=='string'||r.title.length<1||r.title.length>80
    ||!['queued','running','completed','failed','cancelled','timed_out','interrupted'].includes(r.state)
    ||!(r.pid===null||(Number.isSafeInteger(r.pid)&&r.pid>0))
    ||!Number.isSafeInteger(r.startedAt)||!Number.isSafeInteger(r.updatedAt)
    ||!(r.endedAt===null||Number.isSafeInteger(r.endedAt))
    ||!Number.isSafeInteger(r.subagentsStarted)||r.subagentsStarted<0
    ||(r.logFirstCursor!==undefined&&(!Number.isSafeInteger(r.logFirstCursor)||r.logFirstCursor<0)))throw Error('Invalid Codex task record');
  return r;
}
function records(files,directory){
  if(!fs.existsSync(directory))return [];
  files.assertPrivatePath(directory,{directory:true});
  return fs.readdirSync(directory,{withFileTypes:true}).filter(e=>e.isDirectory()&&UUID.test(e.name)).flatMap(e=>{
    try{return [readRecord(files,directory,e.name)];}catch{return [];}
  });
}
function runningRecords(files,directory,now=Date.now()){
  return records(files,directory).filter(r=>{
    if(r.state!=='running'||r.pid===null||r.updatedAt>now||now-r.updatedAt>=45000)return false;
    try{const p=files.inspectProcess(r.pid);return p.state==='alive'&&(!r.pidStartedAt||r.pidStartedAt===p.startTime);}catch{return false;}
  });
}
function requestCancel(files,directory,id,now=Date.now()){
  if(!runningRecords(files,directory,now).some(r=>r.taskId===id))throw Error('pc_codex_task_not_found');
  files.writePrivateAtomic(taskPath(directory,id,'cancel.request'),Buffer.from('cancel'));
}
function pendingApprovals(files,directory,now=Date.now()){
  return records(files,directory).filter(r=>r.state==='queued').flatMap(r=>{
    try{
      if(fs.existsSync(taskPath(directory,r.taskId,'approval.response')))return [];
      const q=readJson(files,taskPath(directory,r.taskId,'approval.request'));
      if(q.taskId!==r.taskId||q.title!==r.title||typeof q.projectRoot!=='string'||q.projectRoot.length>4096
        ||typeof q.promptPreview!=='string'||q.promptPreview.length>1200
        ||!Number.isInteger(q.maxSubagents)||q.maxSubagents<0||q.maxSubagents>4
        ||!Number.isInteger(q.timeoutMinutes)||q.timeoutMinutes<1||q.timeoutMinutes>240
        ||!Number.isSafeInteger(q.expiresAt)||q.expiresAt<=now||q.expiresAt>now+120000)return [];
      return [q];
    }catch{return [];}
  });
}
function respond(files,directory,request,approved,now=Date.now()){
  if(!pendingApprovals(files,directory,now).some(q=>q.taskId===request.taskId&&q.expiresAt===request.expiresAt))return false;
  files.writePrivateAtomic(taskPath(directory,request.taskId,'approval.response'),Buffer.from(JSON.stringify({taskId:request.taskId,approved:approved===true})));
  return true;
}
module.exports={codexTaskDirectory,readRecord,runningRecords,requestCancel,pendingApprovals,respond};
