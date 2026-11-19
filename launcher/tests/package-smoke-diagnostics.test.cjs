const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarizeLauncherLog, rememberTree, runLinuxLauncher, safeErrorCode, makeSmokeTemp, linuxSmokeOptions, summarizeOutput, singletonEntries, summarizePs, safeCommand } = require('../scripts/package-smoke-diagnostics.cjs');

test('Linux socket temp stays short while durable workspace and other platforms stay unchanged', () => {
  const old = '/home/runner/work/feno-bridge/feno-bridge/.cache/codex-web-gpt-package-smoke-123456/tmp';
  const suffix = '/.org.chromium.Chromium.123456/SingletonSocket';
  assert.ok(Buffer.byteLength(old+suffix)>107);
  const calls=[];
  const mkdir=prefix=>{calls.push(prefix);return prefix+'123456';};
  const temp=makeSmokeTemp('linux',old,mkdir);
  assert.deepEqual(calls,['/tmp/feno-smoke-']);
  assert.ok(Buffer.byteLength(temp+suffix)<=107);
  assert.equal(makeSmokeTemp('win32',old,mkdir),old);
  assert.equal(makeSmokeTemp('darwin',old,mkdir),old);
  const env={TMPDIR:temp,TEMP:temp,TMP:temp,CODEX_CHATGPT_WEB_HOME:old+'/core-home'};
  const opts=linuxSmokeOptions('/artifact.AppImage',env);
  assert.deepEqual(opts.args,['-a','/artifact.AppImage','--launcher-smoke-test','--enable-logging=stderr']);
  assert.equal(opts.env.ELECTRON_ENABLE_LOGGING,'1');
  assert.equal(opts.env.APPIMAGE_EXTRACT_AND_RUN,'1');
  assert.equal(opts.env.CODEX_CHATGPT_WEB_HOME,env.CODEX_CHATGPT_WEB_HOME);
  assert.equal(opts.env.TMPDIR,temp);
  assert.equal(env.ELECTRON_ENABLE_LOGGING,undefined);
});

test('Linux lock diagnostics reveal socket failure, owner PID and process type without private data', () => {
  const filesystem={lstatSync:()=>({isSymbolicLink:()=>true}),existsSync:()=>false,readlinkSync(file){
    return file.endsWith('SingletonLock')?'private-host-123':file.endsWith('SingletonCookie')?'secret-cookie':'/private/path/SingletonSocket';
  }};
  const entries=singletonEntries('/private/profile',filesystem);
  assert.equal(entries[0].ownerPid,123);
  assert.equal(entries[2].socketName,true);
  assert.equal(entries[2].exists,false);
  const output=summarizeOutput('Socket path too long: /private/path\nsecret-token\nProcessSingleton: failed to bind');
  assert.deepEqual(output,['socket_path_too_long','redacted','process_singleton,socket_bind']);
  assert.equal(summarizeOutput(Array(100).fill('secret').join('\n')).length,80);
  const ps=summarizePs(' 123 1 Sl 45 electron /private/electron --type=renderer --token=secret\n 456 1 S 20 unrelated /private/other');
  assert.deepEqual(ps,[{pid:123,ppid:1,state:'Sl',elapsedSeconds:45,comm:'electron',cmdline:'electron --type=renderer'}]);
  assert.equal(safeCommand('/private/chrome\0--type=gpu-process\0--token=secret'), 'chrome --type=gpu-process');
  assert.doesNotMatch(JSON.stringify({entries,ps,output}),/private|secret/i);
});

test('diagnostics retain last 60 events and phase timings, never arbitrary strings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-diag-'));
  try {
    const file = path.join(dir, 'launcher.jsonl');
    assert.deepEqual(summarizeLauncherLog(file), {events: [], phases: []});
    const phase = {event:'launcher.boot_phase_finished',detail:{phase:'runtime_source',durationMs:123,token:'secret',path:'C:/user/private'}};
    fs.writeFileSync(file+'.1',JSON.stringify(phase)+'\n');
    const records = Array.from({length:65},()=>({event:'private-token',detail:{phase:'private-path',code:'private-code',message:'private-message'}}));
    records.push({event:'launcher.smoke_failed',detail:{code:'ETIMEDOUT',message:'secret'}});
    records.push({event:'launcher.single_instance_lock_return',detail:{gotLock:false,token:'secret'}});
    fs.writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n{broken');
    const summary = summarizeLauncherLog(file);
    assert.equal(summary.events.length,60);
    assert.deepEqual(summary.events.at(-2),{event:'launcher.smoke_failed',code:'ETIMEDOUT'});
    assert.deepEqual(summary.events.at(-1),{event:'launcher.single_instance_lock_return',gotLock:false});
    assert.deepEqual(summary.phases,[{event:phase.event,phase:'runtime_source',durationMs:123}]);
    assert.doesNotMatch(JSON.stringify(summary), /secret|private|token/);
    assert.equal(safeErrorCode({code:'secret'}),'SMOKE_FAILED');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('Linux tree tracking includes detached descendants, excludes unrelated and reused identities', () => {
  const known = new Map();
  const p = (parent,session,start) => ({parent,session,start});
  rememberTree(10,known,new Map([[10,p(1,10,'a')],[20,p(10,20,'b')],[30,p(20,20,'c')],[40,p(1,10,'d')],[50,p(1,50,'e')]]));
  assert.deepEqual([...known],[[10,'a'],[20,'b'],[30,'c'],[40,'d']]);
  rememberTree(10,known,new Map([[20,p(1,20,'new')],[60,p(20,20,'f')],[30,p(1,20,'c')],[70,p(30,70,'g')]]));
  assert.equal(known.has(60),false);
  assert.equal(known.get(70),'g');
});

test('Linux deadline stops an isolated detached subprocess tree', {skip:process.platform!=='linux'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'smoke-tree-'));
  try {
    const file=path.join(dir,'pid');
    const code=`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)`;
    await assert.rejects(runLinuxLauncher(process.execPath,['-e',code,file],{cwd:dir,env:process.env,timeout:1500}),{code:'ETIMEDOUT'});
    const pid=Number(fs.readFileSync(file,'utf8'));
    // A killed orphan may briefly remain a zombie until PID 1 reaps it.
    let stat=''; try { stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'); } catch(e) { assert.equal(e.code,'ENOENT'); }
    if(stat) assert.equal(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0],'Z');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
