const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarizeLauncherLog, rememberTree, runLinuxLauncher, safeErrorCode } = require('../scripts/package-smoke-diagnostics.cjs');

test('diagnostics retain last 60 events and phase timings, never arbitrary strings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-diag-'));
  try {
    const file = path.join(dir, 'launcher.jsonl');
    assert.deepEqual(summarizeLauncherLog(file), {events: [], phases: []});
    const phase = {event:'launcher.boot_phase_finished',detail:{phase:'runtime_source',durationMs:123,token:'secret',path:'C:/user/private'}};
    fs.writeFileSync(file+'.1',JSON.stringify(phase)+'\n');
    const records = Array.from({length:65},()=>({event:'private-token',detail:{phase:'private-path',code:'private-code',message:'private-message'}}));
    records.push({event:'launcher.smoke_failed',detail:{code:'ETIMEDOUT',message:'secret'}});
    fs.writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n{broken');
    const summary = summarizeLauncherLog(file);
    assert.equal(summary.events.length,60);
    assert.deepEqual(summary.events.at(-1),{event:'launcher.smoke_failed',code:'ETIMEDOUT'});
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
