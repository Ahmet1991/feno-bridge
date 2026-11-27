import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PcAuthorizer} from '../src/pc-control/authorization';
const windowsTest = process.platform === 'win32' ? test : test.skip;
const fixture = join(import.meta.dir, 'fixtures', 'pc-jobs-child.ts');
const managers: {revokeAll():Promise<void>}[] = [];
afterEach(async () => {for (const manager of managers.splice(0)) await manager.revokeAll();});
async function api() { return await import('../src/pc-control/jobs'); }
function approve(root:string, id='pc-jobs-grant-0001', profileId:'pc2-normal'|'pc2-dev'='pc2-normal', terminal=true) {
  const authorizer = new PcAuthorizer({profileId});
  authorizer.setGrantFromLocalApproval({profileId,id,expiresAt:Date.now()+60000,roots:[root],permissions:terminal?['jobs','terminal.exec']:['jobs'],allowedApps:[]});
  return authorizer;
}
async function setup(mode='hold', extra:string[]=[], overrides:Record<string,unknown>={}) {
  const root=mkdtempSync(join(tmpdir(),'pc-jobs-'));
  const authorizer=approve(root);
  let leases=0, releases=0;
  const {createPcJobManager}=await api();
  const manager=createPcJobManager({projectRoot:root,profileId:'pc2-normal',commandSpecs:{'unit-tests':{command:process.execPath,args:[fixture,mode,...extra],usesEmulator:false}},
    acquireLease:async()=>{leases++;return {generation:'fixture-generation',async releaseAfterExit(exit:Promise<void>){await exit;releases++;}};},auditCommand:()=>{},...overrides});
  managers.push(manager); return {root,authorizer,manager,counts:()=>({leases,releases})};
}
async function until(predicate:()=>boolean|Promise<boolean>, timeout=7000) {
  const deadline=Date.now()+timeout;
  while(!await predicate()){if(Date.now()>=deadline)throw Error('fixture condition timed out');await Bun.sleep(20);}
}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

windowsTest('all fixed jobs preserve exit codes and release after contained exit',async()=>{
  const c=await setup('exit'); const {jobId}=await c.manager.startPcJob({kind:'unit-tests',projectRoot:c.root},c.authorizer);
  await until(()=>c.manager.activeJobCount()===0);
  expect(c.manager.pcJobStatus(jobId,c.authorizer)).toEqual({state:'failed',exitCode:7});
  expect(c.manager.pcJobLogs(jobId,0,c.authorizer).lines).toEqual(['hello','error']);
  expect(c.counts()).toEqual({leases:1,releases:1});
});
windowsTest('all job kinds have a finite timeout and cancellation kills children and grandchildren after root exit',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pc-jobs-tree-')), pids=join(dir,'pids');
  const c=await setup('tree',[pids],{jobTimeoutMs:4000});
  const {jobId}=await c.manager.startPcJob({kind:'unit-tests',projectRoot:c.root},c.authorizer);
  await until(()=>existsSync(pids)&&readFileSync(pids,'utf8').trim().split('\n').length===2);
  const children=readFileSync(pids,'utf8').trim().split('\n').map(Number);
  await until(()=>existsSync(pids+'.root')&&!alive(Number(readFileSync(pids+'.root','utf8'))));
  expect(c.manager.activeJobCount()).toBe(1);expect(c.counts().releases).toBe(0);
  expect(children.every(alive)).toBe(true);
  await c.manager.cancelPcJob(jobId,c.authorizer);
  expect(children.some(alive)).toBe(false);expect(c.manager.activeJobCount()).toBe(0);expect(c.counts().releases).toBe(1);
  const t=await setup('hold',[],{jobTimeoutMs:80});const started=await t.manager.startPcJob({kind:'unit-tests',projectRoot:t.root},t.authorizer);
  await until(()=>t.manager.activeJobCount()===0);expect(t.manager.pcJobStatus(started.jobId,t.authorizer).state).toBe('timed_out');
});
windowsTest('T15 per-request timeout overrides the default, marks timed_out and frees the lease',async()=>{
  const c=await setup('hold',[],{jobTimeoutMs:100});
  const {jobId}=await c.manager.startPcJob({kind:'unit-tests',projectRoot:c.root,timeoutSeconds:1},c.authorizer);
  await Bun.sleep(250);
  expect(c.manager.pcJobStatus(jobId,c.authorizer).state).toBe('running');
  await until(()=>c.manager.activeJobCount()===0,4500);
  expect(c.manager.pcJobStatus(jobId,c.authorizer).state).toBe('timed_out');
  expect(c.counts()).toEqual({leases:1,releases:1});
  const terminal=await c.manager.startTerminalCommand({projectRoot:c.root,command:'Start-Sleep -Seconds 20',purpose:'T15 timeout',timeoutSeconds:1},c.authorizer);
  await until(()=>c.manager.activeJobCount()===0,4500);
  expect(c.manager.pcJobStatus(terminal.jobId,c.authorizer).state).toBe('timed_out');
  expect(c.counts()).toEqual({leases:2,releases:2});
  await expect(c.manager.startPcJob({kind:'unit-tests',projectRoot:c.root,timeoutSeconds:601},c.authorizer)).rejects.toThrow('pc_access_denied');
});
windowsTest('grant and profile ownership cannot transfer while acquiring or reading an existing job',async()=>{
  const c=await setup();const {jobId}=await c.manager.startPcJob({kind:'unit-tests',projectRoot:c.root},c.authorizer);
  const foreign=approve(c.root,'pc-jobs-foreign-01','pc2-dev'),replacement=approve(c.root,'pc-jobs-replace-01');
  for(const other of [foreign,replacement]){
    expect(()=>c.manager.pcJobStatus(jobId,other)).toThrow('pc_access_denied');
    expect(()=>c.manager.pcJobLogs(jobId,0,other)).toThrow('pc_access_denied');
    await expect(c.manager.cancelPcJob(jobId,other)).rejects.toThrow('pc_access_denied');
  }
  let continueLease!:()=>void, released=false;
  const gate=new Promise<void>(r=>continueLease=r);
  const b=await setup('hold',[],{acquireLease:async()=>{await gate;return {generation:'late-lease',async releaseAfterExit(exit:Promise<void>){await exit;released=true;}};}});
  const starting=b.manager.startPcJob({kind:'unit-tests',projectRoot:b.root},b.authorizer);
  b.authorizer.revoke();continueLease();await expect(starting).rejects.toThrow('pc_access_denied');
  expect(b.manager.activeJobCount()).toBe(0);expect(released).toBe(true);
});
windowsTest('grant replacement during an asynchronous audit never starts the command',async()=>{
  let auditStarted!:()=>void,finishAudit!:()=>void;
  const entered=new Promise<void>(r=>auditStarted=r),gate=new Promise<void>(r=>finishAudit=r);
  const c=await setup('hold',[],{auditCommand:async()=>{auditStarted();await gate;}});
  const starting=c.manager.startTerminalCommand({projectRoot:c.root,command:'Write-Output should-not-run',purpose:'fixture audit race'},c.authorizer);
  await entered;c.authorizer.setGrantFromLocalApproval({profileId:'pc2-normal',id:'pc-jobs-new-grant-02',expiresAt:Date.now()+60000,roots:[c.root],permissions:['jobs','terminal.exec'],allowedApps:[]});
  finishAudit();await expect(starting).rejects.toThrow('pc_access_denied');
  expect(c.counts()).toEqual({leases:1,releases:1});expect(c.manager.activeJobCount()).toBe(0);
});
windowsTest('a failed durable lease release retains shared capacity after native completion',async()=>{
  const {createPcJobResources}=await api();const resources=createPcJobResources();
  const c=await setup('exit',[],{resources,acquireLease:async()=>({generation:'failure-fixture',async releaseAfterExit(exit:Promise<void>){await exit;throw Error('fixture lease journal failed');}})});
  const {jobId}=await c.manager.startPcJob({kind:'unit-tests',projectRoot:c.root},c.authorizer);
  await until(()=>c.manager.pcJobStatus(jobId,c.authorizer).state==='failed');
  expect(resources.activeJobCount()).toBe(1);expect(c.manager.activeJobCount()).toBe(1);
  await expect(c.manager.revokeAll()).rejects.toThrow('fixture lease journal failed');
  // Native completion already proved zero processes. This synthetic failed
  // journal intentionally has no releasable host handle to clean up.
  managers.splice(managers.indexOf(c.manager),1);
});
windowsTest('shared resources retain a retiring terminal and require jobs plus terminal permission',async()=>{
  const {createPcJobResources}=await api();const resources=createPcJobResources({terminalWaitMs:0});
  const c=await setup('hold',[],{resources});const d=await setup('hold',[],{resources});
  await expect(c.manager.startTerminalCommand({projectRoot:c.root,command:'Start-Sleep -Seconds 30',purpose:'fixture terminal'},approve(c.root,'pc-jobs-only-001','pc2-normal',false))).rejects.toThrow('pc_access_denied');
  await c.manager.startTerminalCommand({projectRoot:c.root,command:'Start-Sleep -Seconds 30',purpose:'fixture terminal'},c.authorizer);
  const retiring=c.manager.revokeAll();
  await expect(d.manager.startTerminalCommand({projectRoot:d.root,command:'Write-Output ok',purpose:'fixture terminal'},d.authorizer)).rejects.toThrow('pc_terminal_busy');
  await retiring;expect(resources.activeJobCount()).toBe(0);expect(resources.hasActiveTerminal()).toBe(false);
});
windowsTest('two full-access slots without a queue share one durable lease until both exit',async()=>{
  const {createPcJobResources}=await api();
  const c=await setup('hold',[],{resources:createPcJobResources({fullAccessTerminalSlots:2,terminalWaitMs:0})});
  c.authorizer.setGrantFromLocalApproval({profileId:'pc2-normal',id:'full-access-123',expiresAt:null,fullAccess:true,roots:['C:\\','D:\\'],permissions:['files.read','files.write','jobs','terminal.exec','screen.read','screen.full','desktop.input','desktop.advanced','apps.launch','adb','runner','browser','chrome.user'],allowedApps:[]});
  const start=()=>c.manager.startTerminalCommand({projectRoot:c.root,command:'Start-Sleep -Seconds 30',purpose:'parallel fixture'},c.authorizer);
  const a=await start(),b=await start();
  expect(c.manager.activeJobCount()).toBe(2);
  await expect(start()).rejects.toThrow('pc_terminal_busy');
  await c.manager.cancelPcJob(a.jobId,c.authorizer);
  expect(c.counts()).toEqual({leases:1,releases:0});
  const d=await start();
  await c.manager.cancelPcJob(b.jobId,c.authorizer);
  await c.manager.cancelPcJob(d.jobId,c.authorizer);
  expect(c.counts()).toEqual({leases:1,releases:1});
});
windowsTest('developer tasks share containment, timeout, argument quoting and no uncontained launch fallback',async()=>{
  const c=await setup('hold',[],{jobTimeoutMs:70,commandSpecs:{'script:test':{command:process.execPath,args:[fixture,'hold'],usesEmulator:false}}});
  const {jobId}=await c.manager.startDeveloperTask({taskId:'script:test',projectRoot:c.root},c.authorizer);
  await until(()=>c.manager.activeJobCount()===0);expect(c.manager.pcJobStatus(jobId,c.authorizer).state).toBe('timed_out');
  const args=['space value','embedded"quote','trailing\\','日本語',''];const a=await setup('arguments',args);
  const quoted=await a.manager.startPcJob({kind:'unit-tests',projectRoot:a.root},a.authorizer);
  await until(()=>a.manager.activeJobCount()===0);
  expect(a.manager.pcJobLogs(quoted.jobId,0,a.authorizer).lines).toEqual([JSON.stringify(args)]);
  const bad=await setup('hold',[],{commandSpecs:{'unit-tests':{command:'C:\\pc-jobs-fixture-no-such-executable.exe',args:[],usesEmulator:false}}});
  await expect(bad.manager.startPcJob({kind:'unit-tests',projectRoot:bad.root},bad.authorizer)).rejects.toThrow('pc_job_containment_failed');
  expect(bad.counts()).toEqual({leases:1,releases:1});expect(bad.manager.activeJobCount()).toBe(0);
});
windowsTest('UTF-8 byte history and log page bounds apply below the line-count limit',async()=>{
  const c=await setup('bytes');const {jobId}=await c.manager.startPcJob({kind:'unit-tests',projectRoot:c.root},c.authorizer);
  await until(()=>c.manager.activeJobCount()===0);
  const page=c.manager.pcJobLogs(jobId,0,c.authorizer);
  expect(page.endCursor).toBe(1500);expect(page.firstCursor).toBeGreaterThan(900);
  expect(Buffer.byteLength(page.lines.join(''))).toBeLessThanOrEqual(64*1024);
});
windowsTest('PowerShell native exit is preserved and only a hash and redacted purpose reach audit',async()=>{
  const records:unknown[]=[];const c=await setup('hold',[],{auditCommand:(record:unknown)=>records.push(record)});
  const started=await c.manager.startTerminalCommand({projectRoot:c.root,command:'cmd.exe /d /c exit 23',purpose:'password="audit secret"'},c.authorizer);
  await until(()=>c.manager.activeJobCount()===0);
  expect(c.manager.pcJobStatus(started.jobId,c.authorizer)).toEqual({state:'failed',exitCode:23});
  expect(JSON.stringify(records)).not.toContain('audit secret');expect(JSON.stringify(records)).not.toContain('cmd.exe');
  expect(records).toHaveLength(1);
});
windowsTest('logs decode streams independently, redact split and quoted CR values, and bound history',async()=>{
  const c=await setup('logs');const {jobId}=await c.manager.startPcJob({kind:'unit-tests',projectRoot:c.root},c.authorizer);
  const first:string[]=[];let cursor=0;
  while(c.manager.activeJobCount()){
    const page=c.manager.pcJobLogs(jobId,cursor,c.authorizer);first.push(...page.lines);cursor=page.nextCursor;await Bun.sleep(5);
  }
  const page=c.manager.pcJobLogs(jobId,0,c.authorizer);
  expect(page.truncated).toBe(true);expect(page.firstCursor).toBeGreaterThan(0);expect(page.lines.length).toBeLessThanOrEqual(250);
  expect(first.join('\n')).not.toMatch(/quoted secret|chunk-secret|bearer-secret/);
  expect(first.join('\n')).toContain('é');expect(first.join('\n')).toContain('stderr-ok');
  expect(first.every(line=>line.length<=2048)).toBe(true);
});
test('log redaction carries quoted secrets across CR, newlines, chunks and overflowing lines',async()=>{
  const {createPcJobLog}=await import('../src/pc-control/job-logs');const log=createPcJobLog();
  for(const chunk of ['OPENAI_API_KEY="one\r','two\nthree"\nok\n','password="'+ 'hidden'.repeat(2000), '\nmore hidden"\nafter\n'])log.stdout.write(Buffer.from(chunk));
  log.stderr.write(Buffer.from('access_token=unquoted-private\nrefresh_token=refresh-private\n'));
  log.end();const output=log.page(0).lines.join('\n');
  expect(output).not.toMatch(/one|two|three|hidden|unquoted-private|refresh-private/);
  expect(output).toContain('ok');expect(output).toContain('after');
});
windowsTest('long terminal purpose is redacted and bounded, and script errors have a hint',async()=>{
  const records:any[]=[];const c=await setup('hold',[],{auditCommand:(record:unknown)=>records.push(record)});
  const started=await c.manager.startTerminalCommand({projectRoot:c.root,command:"Write-Output PSSecurityException",purpose:'password="private" '+ 'a'.repeat(200)},c.authorizer);
  await until(()=>c.manager.activeJobCount()===0);
  expect(records[0].purpose.length).toBe(160);
  expect(records[0].purpose).not.toContain('private');
  expect(c.manager.pcJobStatus(started.jobId,c.authorizer)).toHaveProperty('hint','pc_script_blocked: .ps1 çalıştırılamıyor; komutu satır içi verin');
});
test('audit purpose redaction handles escaped quotes and prefixed credential names',async()=>{
  const {redactPcText}=await import('../src/pc-control/job-logs');
  const value=redactPcText('OPENAI_API_KEY="first\\"second private" done');
  expect(value).not.toMatch(/first|second|private/);expect(value).toContain('done');
});
windowsTest('owner crash closes its non-inheritable job handle and kills surviving children and grandchildren',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-jobs-owner-')), file=join(root,'pid');
  const owner=Bun.spawn([process.execPath,fixture,'owner',file],{cwd:root,stdout:'ignore',stderr:'pipe'});
  try{
    await until(()=>existsSync(file)&&readFileSync(file,'utf8').trim().split('\n').length===2);
    const pids=readFileSync(file,'utf8').trim().split('\n').map(Number);expect(pids.every(alive)).toBe(true);
    await until(()=>existsSync(file+'.root')&&!alive(Number(readFileSync(file+'.root','utf8'))));
    owner.kill();await owner.exited;await until(()=>pids.every(pid=>!alive(pid)));
  }finally{owner.kill();await owner.exited;}
});
test('developer task selection limits names and leaves script and Git execution in the job manager',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-jobs-catalog-'));
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{test:'bun test','build:prod':'deploy','lint':'lint','deploy':'deploy','test:install':'install'}}));
  const {inferPcDeveloperTasks}=await import('../src/pc-control/developer-tasks');
  expect(Object.keys(inferPcDeveloperTasks(root))).toEqual(['script:lint','script:test']);
});
test('null or non-object script catalogs deny script discovery without throwing',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-jobs-null-'));const {inferPcCommandSpecs}=await api();
  const {inferPcDeveloperTasks}=await import('../src/pc-control/developer-tasks');
  for(const scripts of [null,false,'test',[]]){
    writeFileSync(join(root,'package.json'),JSON.stringify({scripts}));
    expect(inferPcCommandSpecs(root)).toEqual({});expect(inferPcDeveloperTasks(root)).toEqual({});
  }
});
const FULL_GRANT={profileId:'pc2-normal' as const,id:'full-access-123',expiresAt:null,fullAccess:true as const,roots:['C:\\','D:\\'],permissions:['files.read','files.write','jobs','terminal.exec','screen.read','screen.full','desktop.input','desktop.advanced','apps.launch','adb','runner','browser','chrome.user'] as const,allowedApps:[]};
const soon=(ms=5000)=>performance.now()+ms;
type Resources=ReturnType<Awaited<ReturnType<typeof api>>['createPcJobResources']>;
const waitSlot=(resources:Resources,ms=5000)=>Promise.resolve(resources.reserveTerminal(false,true,soon(ms)));
test('terminal slot defaults, bounds and local environment overrides',async()=>{
  const {createPcJobResources,pcJobResourceOptionsFromEnv}=await api();
  const defaults=createPcJobResources();
  expect(defaults.terminalSlots(true)).toEqual({used:0,free:4,total:4,queued:0});
  expect(defaults.terminalSlots(false)).toEqual({used:0,free:1,total:1,queued:0});
  expect(defaults.terminalWaitMs).toBe(45000);
  const bounded=createPcJobResources({fullAccessTerminalSlots:99,terminalWaitMs:999999});
  expect(bounded.terminalSlots(true).total).toBe(8);expect(bounded.terminalWaitMs).toBe(120000);
  expect(pcJobResourceOptionsFromEnv({FENO_PC_TERMINAL_SLOTS:' 3 ',FENO_PC_TERMINAL_WAIT_SECONDS:'20'})).toEqual({fullAccessTerminalSlots:3,terminalWaitMs:20000});
  expect(pcJobResourceOptionsFromEnv({FENO_PC_TERMINAL_SLOTS:'many',FENO_PC_TERMINAL_WAIT_SECONDS:'-5'})).toEqual({});
});
test('full-access terminals queue for a free slot and start in arrival order',async()=>{
  const {createPcJobResources}=await api();const resources=createPcJobResources({fullAccessTerminalSlots:2});
  const first=resources.reserve(false,true,true),second=resources.reserve(false,true,true);
  expect(resources.terminalSlots(true)).toEqual({used:2,free:0,total:2,queued:0});
  const order:string[]=[];
  expect(()=>resources.reserve(false,true,true)).toThrow('pc_terminal_busy');
  const third=waitSlot(resources).then(release=>{order.push('third');return release;});
  const fourth=waitSlot(resources).then(release=>{order.push('fourth');return release;});
  await Bun.sleep(20);expect(order).toEqual([]);expect(resources.terminalSlots(true).queued).toBe(2);
  first();const releaseThird=await third;expect(order).toEqual(['third']);
  second();const releaseFourth=await fourth;expect(order).toEqual(['third','fourth']);
  expect(resources.terminalSlots(true)).toEqual({used:2,free:0,total:2,queued:0});
  releaseThird();releaseFourth();expect(resources.hasActiveTerminal()).toBe(false);expect(resources.activeJobCount()).toBe(0);
});
test('a terminal that waits past its deadline gets pc_terminal_busy with a retry hint and holds no slot',async()=>{
  const {createPcJobResources}=await api();const {PcOperationError}=await import('../src/pc-control/errors');
  const resources=createPcJobResources({fullAccessTerminalSlots:1});
  const held=resources.reserve(false,true,true);
  const error=await waitSlot(resources,50).then(()=>undefined,(e:unknown)=>e);
  expect(error).toBeInstanceOf(PcOperationError);
  const busy=error as InstanceType<typeof PcOperationError>;
  expect(busy.code).toBe('pc_terminal_busy');
  expect(busy.details).toMatchObject({retryAfterSeconds:30});
  expect(busy.details?.reason).toContain('tekrarlayın');
  expect(resources.terminalSlots(true)).toEqual({used:1,free:0,total:1,queued:0});
  held();const immediate=resources.reserveTerminal(false,true,soon(0));expect(typeof immediate).toBe('function');
  (immediate as ()=>void)();expect(resources.hasActiveTerminal()).toBe(false);
});
test('ordinary jobs keep the immediate pc_job_busy refusal while terminals wait for capacity',async()=>{
  const {createPcJobResources}=await api();const resources=createPcJobResources({fullAccessTerminalSlots:1,maxActiveJobs:1});
  const job=resources.reserve(false,false);
  expect(()=>resources.reserve(false,false)).toThrow('pc_job_busy');
  await expect(waitSlot(resources,30)).rejects.toThrow('pc_terminal_busy');
  const terminal=waitSlot(resources);job();(await terminal)();
  expect(resources.activeJobCount()).toBe(0);
});
test('another grant waits for the shared terminal lease to close instead of failing at once',async()=>{
  const {createPcJobResources}=await api();const resources=createPcJobResources();
  let acquired=0,released=0;
  const acquire=async()=>{acquired++;const generation=`fixture-${acquired}`;return {generation,async releaseAfterExit(exit:Promise<void>){await exit;released++;}};};
  const first=await resources.sharedTerminalLease('grant-aaaa-0001',acquire,soon());
  const second=resources.sharedTerminalLease('grant-bbbb-0002',acquire,soon());
  await Bun.sleep(20);expect(acquired).toBe(1);
  await first.releaseAfterExit(Promise.resolve());
  const lease=await second;expect(lease.generation).toBe('fixture-2');expect(released).toBe(1);
  await lease.releaseAfterExit(Promise.resolve());expect(released).toBe(2);
  // Without a deadline the call keeps the immediate refusal.
  const held=await resources.sharedTerminalLease('grant-aaaa-0001',acquire);
  await expect(resources.sharedTerminalLease('grant-bbbb-0002',acquire)).rejects.toThrow('pc_terminal_busy');
  await held.releaseAfterExit(Promise.resolve());expect(released).toBe(3);
});
windowsTest('full access runs four terminals under one durable lease and queues the fifth until one exits',async()=>{
  const {createPcJobResources}=await api();const resources=createPcJobResources({terminalWaitMs:20000});
  const c=await setup('hold',[],{resources});
  c.authorizer.setGrantFromLocalApproval({...FULL_GRANT,permissions:[...FULL_GRANT.permissions]});
  const start=()=>c.manager.startTerminalCommand({projectRoot:c.root,command:'Start-Sleep -Seconds 30',purpose:'parallel fixture'},c.authorizer);
  const running=await Promise.all([start(),start(),start(),start()]);
  expect(c.manager.activeJobCount()).toBe(4);
  let fifthStarted=false;const fifth=start().then(job=>{fifthStarted=true;return job;});
  await Bun.sleep(200);expect(fifthStarted).toBe(false);expect(resources.terminalSlots(true)).toMatchObject({used:4,free:0,queued:1});
  await c.manager.cancelPcJob(running[0]!.jobId,c.authorizer);
  const queued=await fifth;expect(c.counts()).toEqual({leases:1,releases:0});
  for(const job of [...running.slice(1),queued])await c.manager.cancelPcJob(job.jobId,c.authorizer);
  expect(c.counts()).toEqual({leases:1,releases:1});
});
windowsTest('a queued terminal starts once a retiring terminal frees the only slot',async()=>{
  const {createPcJobResources}=await api();const resources=createPcJobResources({terminalWaitMs:20000});
  const c=await setup('hold',[],{resources});const d=await setup('hold',[],{resources});
  await c.manager.startTerminalCommand({projectRoot:c.root,command:'Start-Sleep -Seconds 30',purpose:'fixture terminal'},c.authorizer);
  const retiring=c.manager.revokeAll();
  const {jobId}=await d.manager.startTerminalCommand({projectRoot:d.root,command:'Write-Output ok',purpose:'fixture terminal'},d.authorizer);
  await retiring;await until(()=>d.manager.activeJobCount()===0);
  expect(d.manager.pcJobStatus(jobId,d.authorizer)).toEqual({state:'succeeded',exitCode:0});
});
