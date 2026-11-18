import {chromium} from 'playwright-core';
import {mkdtempSync,cpSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'feno-own-chrome-'));
const extension=join(root,'extension');
cpSync(join(import.meta.dir,'../launcher/chrome-extension'),extension,{recursive:true});
// Test-only worker calls the real engine, without registering a host or contacting a live broker.
writeFileSync(join(extension,'worker.js'),"import {createChromeEngine} from './engine.js'; const original=chrome.debugger.sendCommand.bind(chrome.debugger); const detach=chrome.debugger.detach.bind(chrome.debugger); globalThis.fixtureDetached=[]; chrome.debugger.detach=async (target)=>{await detach(target);globalThis.fixtureDetached.push({tabId:target.tabId,at:Date.now()});}; chrome.debugger.sendCommand=(...args)=>globalThis.fixtureHang?new Promise(()=>{}):original(...args); globalThis.fixtureEngine=createChromeEngine(chrome);");
const executable=join(process.env.LOCALAPPDATA!,'ms-playwright','chromium-1255','chrome-win64','chrome.exe');
const compiler=['Framework64','Framework'].map(x=>join(process.env.SystemRoot!,'Microsoft.NET',x,'v4.0.30319','csc.exe')).find(existsSync)!;
const probe=join(root,'foreground.dll');
assert.equal(Bun.spawnSync([compiler,'/nologo','/target:library','/out:'+probe,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',join(import.meta.dir,'sample-browser-foreground.cs')]).exitCode,0);
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<html><body style="min-height:4000px"><h1>Fixture PC2</h1><canvas width="200" height="100" style="position:absolute;left:30px;top:80px;background:#ddd"></canvas><input aria-label="Write here" style="position:absolute;left:30px;top:220px" oninput="document.querySelector(\'p\').textContent=this.value"><p style="position:absolute;top:260px"></p><div id="result" style="position:absolute;top:300px"></div><div style="position:absolute;top:350px;left:30px;width:200px;height:100px;overflow:auto" id="nested"><div style="height:800px">nested</div></div><script>document.querySelector("canvas").onclick=()=>document.querySelector("#result").textContent="canvas-clicked"</script></body></html>',{headers:{'content-type':'text/html'}})});
const context=await chromium.launchPersistentContext(join(root,'profile'),{executablePath:executable,headless:false,viewport:null,args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--no-first-run','--no-default-browser-check']});
let focus:ReturnType<typeof Bun.spawn>|undefined;
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
  assert.ok(worker.url().startsWith('chrome-extension://mcimkhafgpcecjdjjiljhljdkaggapfa/'));
  const active=context.pages()[0];
  await active.goto('http://127.0.0.1:'+server.port+'/');
  focus=Bun.spawn(['powershell.exe','-NoProfile','-Sta','-Command','Add-Type -Path $env:FENO_FOCUS_PROBE; [ForegroundProbe]::Run($env:FENO_FOCUS_DIRECTORY)'],{windowsHide:true,stdout:'inherit',stderr:'inherit',env:{...process.env,FENO_FOCUS_PROBE:probe,FENO_FOCUS_DIRECTORY:root}});
  const ready=join(root,'foreground-ready');
  for(let i=0;!existsSync(ready)&&i<100;i++)await Bun.sleep(100);
  assert.ok(existsSync(ready),'focus fixture window was not activated');
  const start=Date.now();
  const run=(action:string,args:any={})=>worker.evaluate(async ({action,args})=>(globalThis as any).fixtureEngine.run(action,args,AbortSignal.timeout((args.timeoutSeconds||30)*1000)),{action,args});
  const before=await run('tabs');
  const {tabId}=await run('open',{url:'http://127.0.0.1:'+server.port+'/'});
  await Bun.sleep(1500);
  const target=await run('tabs');assert.equal(target.windows.flatMap((w:any)=>w.tabs).find((t:any)=>t.tabId===tabId).active,false);
  await assert.rejects(run('computer',{tabId,action:'click',x:10,y:10}),/pc_chrome_screenshot_required/);
  const text=await run('read',{tabId,mode:'text'});assert.match(text.text,/Fixture PC2/);
  const shot=await run('computer',{tabId,action:'screenshot'});assert.ok(shot.width>300&&shot.height>300);
  const metrics=await worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>({w:innerWidth,h:innerHeight})});return r.result;},tabId);
  await run('computer',{tabId,action:'click',x:Math.round(80*shot.width/metrics.w),y:Math.round(110*shot.height/metrics.h)});
  assert.match((await run('read',{tabId,mode:'text'})).text,/canvas-clicked/);
  const found=await run('find',{tabId,query:'Write here'});
  assert.ok(found.nodes[0]);
  await run('type',{tabId,ref:found.nodes[0].ref,text:'smoke-520'});
  assert.match((await run('read',{tabId,mode:'text'})).text,/smoke-520/);
  const withCursor=await run('computer',{tabId,action:'screenshot',includeCursor:true});
  const withoutCursor=await run('computer',{tabId,action:'screenshot',includeCursor:false});
  assert.notEqual(withCursor.base64,withoutCursor.base64);
  const cursor=await worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>{const e=document.querySelector('[data-feno-pc2-cursor]');return e&&getComputedStyle(e).pointerEvents;}});return r.result;},tabId);
  assert.equal(cursor,'none');
  const computer=(action:string,args:any={})=>run('computer',{tabId,action,...args});
  const xy=(x:number,y:number)=>({x:Math.round(x*shot.width/metrics.w),y:Math.round(y*shot.height/metrics.h)});
  const durations:Record<string,number[]>={click:[],hover:[],type:[],key:[],screenshot:[]};
  for(let i=0;i<5;i++)for(const [action,args] of [['click',xy(80,110)],['hover',xy(80,110)],['click',xy(60,230)],['type',{text:'x'}],['key',{key:i%2?'Enter':'escape'}],['screenshot',{includeCursor:true}]] as const){
    const at=performance.now();await computer(action,args);durations[action].push(Math.round(performance.now()-at));
  }
  const median=Object.fromEntries(Object.entries(durations).map(([key,values])=>[key,values.sort((a,b)=>a-b)[Math.floor(values.length/2)]]));
  console.log('OWN_CHROME_LATENCIES '+JSON.stringify({median,durations}));
  const nested=await computer('scroll',{...xy(80,380),delta:100});assert.equal(nested.scrollY,100);assert.equal(nested.pageY,0);
  const rootScroll=await computer('scroll',{...xy(400,150),delta:600});assert.equal(rootScroll.pageY,600);
  const scrollY=await worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>scrollY});return r.result;},tabId);assert.equal(scrollY,600);
  await worker.evaluate(()=>{(globalThis as any).fixtureHang=true;});
  await assert.rejects(computer('key',{key:'Enter',timeoutSeconds:1}),/pc_chrome_timeout/);
  await worker.evaluate(()=>{(globalThis as any).fixtureHang=false;});
  await computer('screenshot');
  const idleStart=Date.now();
  const after=await run('tabs');
  assert.deepEqual(after.windows.flatMap((w:any)=>w.tabs.filter((t:any)=>t.active).map((t:any)=>t.tabId)),before.windows.flatMap((w:any)=>w.tabs.filter((t:any)=>t.active).map((t:any)=>t.tabId)));
  await Bun.sleep(15500);
  const detached=await worker.evaluate(async id=>(globalThis as any).fixtureDetached.filter((d:any)=>d.tabId===id),tabId);
  assert.ok(detached.some((d:any)=>d.at>=idleStart+14500),'extension debugger detach did not complete after idle: '+JSON.stringify(detached));
  const end=Date.now(),expected=readFileSync(ready,'utf8').trim();
  const samples=readFileSync(join(root,'foreground.csv'),'utf8').trim().split(/\r?\n/).map(l=>l.split(',')).filter(r=>Number(r[0])>=start&&Number(r[0])<=end);
  assert.ok(samples.length>=5);assert.equal(samples.filter(r=>r[1]!==expected).length,0,'foreground changed');
  console.log(JSON.stringify({result:'OWN_CHROME_SMOKE_OK',samples:samples.length,foregroundChanges:0,cursor:true,canvas:true,typed:true,activeTabUnchanged:true,scrollY,timeoutRecovery:true,idleDetached:true,medianMs:median,durationsMs:durations,profile:root}));
  assert.ok(Object.values(median).every(ms=>ms<=1500),'median latency target exceeded: '+JSON.stringify(median));
}finally{
  if(focus){writeFileSync(join(root,'foreground-stop'),'stop');await focus.exited;}
  await context.close();server.stop();
}
