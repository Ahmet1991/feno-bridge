const test=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),path=require('node:path');
const event=()=>{const listeners=[];return {addListener:f=>listeners.push(f),fire:(...args)=>listeners.forEach(f=>f(...args))};};
test('extension native worker sends hello, dispatches only host commands, reconnects and reloads',async()=>{
  const ports=[],badges=[],alarms=event();let reloads=0,hang=false;
  const connectNative=name=>{
    assert.equal(name,'com.feno.bridge.pc2');
    const port={onDisconnect:event(),onMessage:event(),sent:[],postMessage(m){this.sent.push(m);}};ports.push(port);return port;
  };
  const previous=globalThis.chrome;
  globalThis.chrome={
    runtime:{getManifest:()=>({version:'5.1.19'}),connectNative,reload:()=>reloads++,onStartup:event(),onInstalled:event()},
    alarms:{create:(name,args)=>{assert.equal(name,'feno-reconnect');assert.equal(args.periodInMinutes,0.5);},onAlarm:alarms},
    tabs:{onUpdated:event(),onRemoved:event()},
    debugger:{onDetach:event()},
    action:{setBadgeText:async value=>badges.push(value)},
    windows:{getAll:async()=>hang?new Promise(()=>{}):[{id:1,focused:false,tabs:[{id:2,title:'Fixture',url:'https://example.test/',active:true}]}]}
  };
  try{
    await import(pathToFileURL(path.join(__dirname,'../chrome-extension/worker.js')).href);
    const first=ports[0];assert.deepEqual(first.sent,[{type:'hello',version:'5.1.19'}]);
    first.onMessage.fire({type:'untrusted',action:'tabs',id:'ignored'});await new Promise(r=>setImmediate(r));assert.equal(first.sent.length,1);
    first.onMessage.fire({type:'command',action:'tabs',args:{},id:'command-1'});
    for(let i=0;i<20&&first.sent.length<2;i++)await new Promise(r=>setImmediate(r));
    assert.deepEqual(first.sent[1],{type:'result',id:'command-1',ok:true,data:{windows:[{windowId:1,focused:false,tabs:[{tabId:2,title:'Fixture',domain:'example.test',active:true}]}]}});
    assert.deepEqual(badges,[{text:'PC2'},{text:''}]);
    hang=true;first.onMessage.fire({type:'command',action:'tabs',args:{},id:'hang'});await new Promise(r=>setImmediate(r));
    first.onMessage.fire({type:'cancel',id:'hang'});hang=false;
    first.onMessage.fire({type:'command',action:'tabs',args:{},id:'after'});
    for(let i=0;i<20&&first.sent.length<4;i++)await new Promise(r=>setImmediate(r));
    assert.deepEqual(first.sent[2],{type:'result',id:'hang',ok:false,code:'pc_chrome_timeout'});
    assert.equal(first.sent[3].id,'after');assert.equal(first.sent[3].ok,true);assert.equal(ports.length,1);
    first.onMessage.fire({type:'reload',version:'5.1.19'});assert.equal(reloads,0);
    first.onMessage.fire({type:'reload',version:'5.1.22'});assert.equal(reloads,1);
    first.onDisconnect.fire();alarms.fire({name:'feno-reconnect'});
    assert.equal(ports.length,2);assert.deepEqual(ports[1].sent,[{type:'hello',version:'5.1.19'}]);
  }finally{globalThis.chrome=previous;}
});
