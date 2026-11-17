const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBootReporter}=require('../electron/startup-timing.cjs');

test('boot logging precedes startup work and records wait and phase durations with an injected clock',()=>{
  let now=1000;const events=[];
  const reporter=createBootReporter({info:(event,detail)=>events.push({event,detail})},{clock:()=>now,processStartedAt:900});
  const done=reporter.begin('runtime_source');now+=20;
  reporter.wait('runtime_source','source_materializing',50);now+=50;done();
  const ready=reporter.begin('electron_ready');now+=10;ready();
  assert.deepEqual(events.map(e=>e.event),['launcher.boot_started','launcher.boot_phase_started','launcher.boot_wait','launcher.boot_phase_finished','launcher.boot_phase_started','launcher.boot_phase_finished']);
  assert.equal(events[0].detail.elapsedMs,100);
  assert.equal(events[2].detail.waitMs,50);
  assert.equal(events[3].detail.durationMs,70);
  assert.equal(events[5].detail.durationMs,10);
});
