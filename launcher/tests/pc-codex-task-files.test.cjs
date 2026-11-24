const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {codexTaskDirectory,runningRecords,requestCancel,pendingApprovals,respond}=require('../electron/pc-codex-task-files.cjs');
const {RuntimeSupervisor}=require('../electron/runtime-supervisor.cjs');
test('activity accepts fresh live running task, excludes stale, dead, reused PID and terminal records',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pc-codex-activity-')),directory=codexTaskDirectory(root),now=Date.now();
  const files={assertPrivatePath(){},readPrivateFile:p=>fs.readFileSync(p),writePrivateAtomic:(p,b)=>fs.writeFileSync(p,b),
    inspectProcess:pid=>({state:pid===1?'dead':'alive',startTime:'live'})};
  function add(overrides){const taskId=randomUUID(),folder=path.join(directory,taskId);fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(path.join(folder,'state.json'),JSON.stringify({taskId,title:'fixture',state:'running',pid:2,pidStartedAt:'live',startedAt:now-1000,updatedAt:now,endedAt:null,subagentsStarted:2,...overrides}));return taskId;}
  try{
    const live=add({}),stale=add({updatedAt:now-45000});add({pid:1});add({pidStartedAt:'old'});add({state:'completed'});add({state:'queued'});
    assert.deepEqual(runningRecords(files,directory,now).map(r=>r.taskId),[live]);
    requestCancel(files,directory,live,now);assert.equal(fs.readFileSync(path.join(directory,live,'cancel.request'),'utf8'),'cancel');
    assert.throws(()=>requestCancel(files,directory,stale,now),/pc_codex_task_not_found/);
    const pending=add({state:'queued',pid:null});const request={taskId:pending,title:'fixture',projectRoot:root,maxSubagents:2,timeoutMinutes:60,promptPreview:'task',expiresAt:now+120000};
    fs.writeFileSync(path.join(directory,pending,'approval.request'),JSON.stringify(request));
    assert.deepEqual(pendingApprovals(files,directory,now),[request]);assert.equal(respond(files,directory,request,false,now),true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,pending,'approval.response'))),{taskId:pending,approved:false});
    assert.equal(respond(files,directory,request,true,now),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('supervisor does not drain proxy while a chat Codex task is active',async()=>{
  const calls=[];let count=1;
  const receiver={activeCodexTaskCount:()=>count,control:async(_config,method)=>{calls.push(method);return {accepting_turns:false,active_http_turns:0,active_browser_turns:0};}};
  await assert.rejects(RuntimeSupervisor.prototype.acquireDrain.call(receiver,{},1),/active chat Codex tasks/);
  assert.deepEqual(calls,[]);count=0;
  assert.equal(await RuntimeSupervisor.prototype.acquireDrain.call(receiver,{},100),true);assert.deepEqual(calls,['drain']);
});
