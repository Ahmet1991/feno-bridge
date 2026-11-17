import {chromium} from 'playwright-core';
import {mkdtempSync,cpSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'feno-own-chrome-'));
const extension=join(root,'extension');
cpSync(join(import.meta.dir,'../launcher/chrome-extension'),extension,{recursive:true});
// Test-only worker calls the real engine, without registering a host or contacting a live broker.
writeFileSync(join(extension,'worker.js'),"import {createChromeEngine} from './engine.js'; globalThis.fixtureEngine=createChromeEngine(chrome);");
const executable=join(process.env.LOCALAPPDATA!,'ms-playwright','chromium-1255','chrome-win64','chrome.exe');
const compiler=['Framework64','Framework'].map(x=>join(process.env.SystemRoot!,'Microsoft.NET',x,'v4.0.30319','csc.exe')).find(existsSync)!;
const probe=join(root,'foreground.dll');
assert.equal(Bun.spawnSync([compiler,'/nologo','/target:library','/out:'+probe,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',join(import.meta.dir,'sample-browser-foreground.cs')]).exitCode,0);
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<html><body><h1>Fixture PC2</h1><canvas width="200" height="100" style="position:absolute;left:30px;top:80px;background:#ddd"></canvas><input aria-label="Write here" style="position:absolute;left:30px;top:220px" oninput="document.querySelector(\'p\').textContent=this.value"><p style="position:absolute;top:260px"></p><div id="result" style="position:absolute;top:300px"></div><script>document.querySelector("canvas").onclick=()=>document.querySelector("#result").textContent="canvas-clicked"</script></body></html>',{headers:{'content-type':'text/html'}})});
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
  const run=(action:string,args:any={})=>worker.evaluate(async ({action,args})=>(globalThis as any).fixtureEngine.run(action,args),{action,args});
  const before=await run('tabs');
  const {tabId}=await run('open',{url:'http://127.0.0.1:'+server.port+'/'});
  await Bun.sleep(1500);
  const text=await run('read',{tabId,mode:'text'});assert.match(text.text,/Fixture PC2/);
  const shot=await run('computer',{tabId,action:'screenshot'});assert.ok(shot.width>300&&shot.height>300);
  const metrics=await worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>({w:innerWidth,h:innerHeight})});return r.result;},tabId);
  await run('computer',{tabId,action:'click',x:Math.round(80*shot.width/metrics.w),y:Math.round(110*shot.height/metrics.h)});
  assert.match((await run('read',{tabId,mode:'text'})).text,/canvas-clicked/);
  const found=await run('find',{tabId,query:'Write here'});
  assert.ok(found.nodes[0]);
  await run('type',{tabId,ref:found.nodes[0].ref,text:'smoke-519'});
  assert.match((await run('read',{tabId,mode:'text'})).text,/smoke-519/);
  const withCursor=await run('computer',{tabId,action:'screenshot',includeCursor:true});
  const withoutCursor=await run('computer',{tabId,action:'screenshot',includeCursor:false});
  assert.notEqual(withCursor.base64,withoutCursor.base64);
  const cursor=await worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>{const e=document.querySelector('[data-feno-pc2-cursor]');return e&&getComputedStyle(e).pointerEvents;}});return r.result;},tabId);
  assert.equal(cursor,'none');
  const after=await run('tabs');
  assert.deepEqual(after.windows.flatMap((w:any)=>w.tabs.filter((t:any)=>t.active).map((t:any)=>t.tabId)),before.windows.flatMap((w:any)=>w.tabs.filter((t:any)=>t.active).map((t:any)=>t.tabId)));
  await Bun.sleep(700);
  const end=Date.now(),expected=readFileSync(ready,'utf8').trim();
  const samples=readFileSync(join(root,'foreground.csv'),'utf8').trim().split(/\r?\n/).map(l=>l.split(',')).filter(r=>Number(r[0])>=start&&Number(r[0])<=end);
  assert.ok(samples.length>=5);assert.equal(samples.filter(r=>r[1]!==expected).length,0,'foreground changed');
  console.log(JSON.stringify({result:'OWN_CHROME_SMOKE_OK',samples:samples.length,foregroundChanges:0,cursor:true,canvas:true,typed:true,activeTabUnchanged:true,profile:root}));
}finally{
  if(focus){writeFileSync(join(root,'foreground-stop'),'stop');await focus.exited;}
  await context.close();server.stop();
}
