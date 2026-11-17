const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {bindTunnelWake}=require('../electron/tunnel-wake.cjs');
const {RuntimeSupervisor}=require('../electron/runtime-supervisor.cjs');

test('resume probes immediately and recovers stale connection, coalescing unlock',async()=>{
  const power=new EventEmitter();const calls=[];let finish;
  const dispose=bindTunnelWake(power,async event=>{calls.push(event);await new Promise(resolve=>{finish=resolve;});});
  power.emit('resume');power.emit('unlock-screen');
  assert.deepEqual(calls,['resume']);finish();await new Promise(setImmediate);
  power.emit('unlock-screen');assert.deepEqual(calls,['resume','unlock-screen']);finish();dispose();
  await new Promise(setImmediate);power.emit('resume');assert.equal(calls.length,2);
});

test('resume probes the owned alias and recovers even when local readiness is stale',async()=>{
  const calls=[],logs=[];
  const fake={stopping:false,startPromise:null,recoveryTasks:new Set(),restartTimers:{},tunnel:{managed:true},tunnelMonitorTimer:true,tunnelMonitorGeneration:0,
    readConfig:()=>({mode:'full'}),stopTunnelMonitor(){this.tunnelMonitorGeneration++;},
    async observeTunnelForMonitor(){calls.push('probe');return {statusKnown:true,ready:true};},
    async recover(name){calls.push(name);},logger:{info:(event,data)=>logs.push({event,...data})}};
  await RuntimeSupervisor.prototype.checkTunnelAfterPowerEvent.call(fake,'resume');
  assert.deepEqual(calls,['probe','tunnel']);assert.equal(logs[0].outcome,'recovered');assert.equal(logs[0].event,'resume');
});
