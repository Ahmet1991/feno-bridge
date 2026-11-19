import {mkdtempSync,cpSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import { removeSmokeDirectory } from './smoke-temp';
const root=mkdtempSync(join(tmpdir(),'feno-own-chrome-'));
try {
const extension=join(root,'extension');
cpSync(join(import.meta.dir,'../launcher/chrome-extension'),extension,{recursive:true});
if(process.env.FENO_BASELINE==='1'){
  for(const name of ['engine.js','dom.js','manifest.json']){
    const old=Bun.spawnSync(['git','show','b4b0498:launcher/chrome-extension/'+name],{cwd:join(import.meta.dir,'..')});
    assert.equal(old.exitCode,0);
    writeFileSync(join(extension,name),old.stdout);
  }
}
// Test-only worker calls the real engine, without registering a host or contacting a live broker.
writeFileSync(join(extension,'worker.js'),"import {createChromeEngine} from './engine.js'; const original=chrome.debugger.sendCommand.bind(chrome.debugger); const detach=chrome.debugger.detach.bind(chrome.debugger); globalThis.fixtureDetached=[]; chrome.debugger.detach=async (target)=>{await detach(target);globalThis.fixtureDetached.push({tabId:target.tabId,at:Date.now()});}; chrome.debugger.sendCommand=(...args)=>{if(globalThis.fixtureHang)return new Promise(()=>{});if(globalThis.fixtureCaptureHang&&args[1]==='Page.captureScreenshot'){globalThis.fixtureCaptureHang=false;return new Promise(()=>{});}return original(...args);}; globalThis.fixtureEngine=createChromeEngine(chrome);");
const executable=join(process.env.LOCALAPPDATA!,'ms-playwright','chromium-1255','chrome-win64','chrome.exe');
const compiler=['Framework64','Framework'].map(x=>join(process.env.SystemRoot!,'Microsoft.NET',x,'v4.0.30319','csc.exe')).find(existsSync)!;
const probe=join(root,'foreground.dll');
assert.equal(Bun.spawnSync([compiler,'/nologo','/target:library','/out:'+probe,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',join(import.meta.dir,'sample-browser-foreground.cs')]).exitCode,0);
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<html><body style="min-height:4000px"><h1>Fixture PC2</h1><canvas width="200" height="100" style="position:absolute;left:30px;top:80px;background:#ddd"></canvas><input aria-label="Write here" style="position:absolute;left:30px;top:220px" oninput="document.querySelector(\'p\').textContent=this.value"><p style="position:absolute;top:260px"></p><div id="result" style="position:absolute;top:300px"></div><div style="position:absolute;top:350px;left:30px;width:200px;height:100px;overflow:auto" id="nested"><div style="height:800px">nested</div></div><script>document.querySelector("canvas").onclick=()=>document.querySelector("#result").textContent="canvas-clicked"</script></body></html>',{headers:{'content-type':'text/html'}})});
// Do not attach Playwright to pages: its emulation changes background visibility.
const profile=join(root,'profile');
const chromeProcess=Bun.spawn([executable,'--user-data-dir='+profile,'--remote-debugging-port=0','--disable-extensions-except='+extension,'--load-extension='+extension,'--no-first-run','--no-default-browser-check','http://127.0.0.1:'+server.port+'/'],{stdout:'ignore',stderr:'ignore'});
let socket:WebSocket|undefined;
let seq=0;
const pending=new Map<number,{resolve:(v:any)=>void,reject:(e:Error)=>void}>();
function cdp(method:string,params:any={},sessionId?:string):Promise<any>{
  return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP deadline: '+method));},45000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});socket!.send(JSON.stringify({id,method,params,sessionId}));});
}
let focus:ReturnType<typeof Bun.spawn>|undefined;
try{
  const portFile=join(profile,'DevToolsActivePort');
  for(let i=0;!existsSync(portFile)&&i<150;i++)await Bun.sleep(100);
  const [port,path]=readFileSync(portFile,'utf8').trim().split(/\r?\n/);
  socket=new WebSocket('ws://127.0.0.1:'+port+path);
  await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=()=>reject(new Error('CDP websocket failed'));});
  socket.onmessage=e=>{const m=JSON.parse(String(e.data));const p=pending.get(m.id);if(p){pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}};
  let targetId:string|undefined;
  for(let i=0;i<150&&!targetId;i++){
    const {targetInfos}=await cdp('Target.getTargets');
    targetId=targetInfos.find((v:any)=>v.type==='service_worker'&&v.url.startsWith('chrome-extension://mcimkhafgpcecjdjjiljhljdkaggapfa/'))?.targetId;
    if(!targetId)await Bun.sleep(100);
  }
  assert.ok(targetId,'test extension worker not found');
  const {sessionId}=await cdp('Target.attachToTarget',{targetId,flatten:true});
  const worker={evaluate:async (fn:(arg:any)=>any,arg?:any)=>{
    const r=await cdp('Runtime.evaluate',{expression:'('+fn.toString()+')('+JSON.stringify(arg)+')',awaitPromise:true,returnByValue:true},sessionId);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
    return r.result.value;
  }};
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
  const visibility=await worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>document.visibilityState});return r.result;},tabId);
  console.log('OWN_CHROME_VISIBILITY '+visibility);
  assert.equal(visibility,'hidden');
  assert.equal(target.windows.find((w:any)=>w.tabs.some((t:any)=>t.tabId===tabId)).focused,false);
  await worker.evaluate(async id=>(globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>{
    const state={click:0,mousemove:0,input:0,untrusted:0,visible:0};
    (globalThis as any).fixtureEvents=state;
    for(const name of ['click','mousemove','input'] as const)document.addEventListener(name,e=>{state[name]++;if(!e.isTrusted)state.untrusted++;});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden')state.visible++;});
  }}),tabId);
  await assert.rejects(run('computer',{tabId,action:'click',x:10,y:10}),/pc_chrome_screenshot_required/);
  const bench:Record<string,number[]>={click:[],hover:[],type:[],screenshot:[]};
  const errors:string[]=[];
  const currentVisibility=()=>worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>document.visibilityState});return r.result;},tabId);
  const measure=async (name:string,fn:()=>Promise<any>)=>{
    assert.equal(await currentVisibility(),'hidden');
    const at=performance.now();
    let result;
    try{result=await fn();}catch(e){errors.push(name+': '+String(e));}finally{bench[name].push(Math.round(performance.now()-at));}
    assert.equal(await currentVisibility(),'hidden');
    return result;
  };
  let first;
  for(let i=0;i<20&&!first;i++)first=await measure('screenshot',()=>run('computer',{tabId,action:'screenshot'}));
  if(first){
    const size=await worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>({w:innerWidth,h:innerHeight})});return r.result;},tabId);
    const xy=(x:number,y:number)=>({x:Math.round(x*first.width/size.w),y:Math.round(y*first.height/size.h)});
    for(let i=0;i<5;i++){
      await measure('click',()=>run('computer',{tabId,action:'click',...xy(80,110)}));
      await measure('hover',()=>run('computer',{tabId,action:'hover',...xy(100,120)}));
      const found=await run('find',{tabId,query:'Write here'});
      await measure('type',()=>run('type',{tabId,ref:found.nodes[0].ref,text:'x'}));
    }
  }
  for(let i=bench.screenshot.length;i<20;i++)await measure('screenshot',()=>run('computer',{tabId,action:'screenshot'}));
  const stats=Object.fromEntries(Object.entries(bench).map(([k,v])=>{const s=[...v].sort((a,b)=>a-b);return [k,{count:s.length,median:(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2,max:s.at(-1)??Infinity,values:v}];}));
  const events=await worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>({...(globalThis as any).fixtureEvents,visibility:document.visibilityState})});return r.result;},tabId);
  console.log('HIDDEN_CHROME_BENCH '+JSON.stringify({stats,errors,visibility,events}));
  const sampled=readFileSync(join(root,'foreground.csv'),'utf8').trim().split(/\r?\n/).map(l=>l.split(',')).filter(r=>Number(r[0])>=start);
  const expectedFocus=readFileSync(ready,'utf8').trim();
  console.log('HIDDEN_CHROME_FOCUS '+JSON.stringify({samples:sampled.length,changes:sampled.filter(r=>r[1]!==expectedFocus).length,testChromePid:chromeProcess.pid,testChromeForeground:sampled.filter(r=>Number(r[2])===chromeProcess.pid).length}));
  assert.ok(sampled.length>=5);assert.equal(sampled.filter(r=>r[1]!==expectedFocus).length,0);
  if(process.env.FENO_BASELINE!=='1'){
  assert.deepEqual(errors,[]);
  assert.equal(events.untrusted,0);assert.equal(events.visibility,'hidden');
  assert.ok(events.click>=10&&events.mousemove>=5&&events.input>=5,'trusted input missing');
  for(const k of ['click','hover','type']){assert.ok(stats[k].median<=1000&&stats[k].max<=2000,k+' latency');}
  assert.ok(stats.screenshot.count===20&&stats.screenshot.median<=1500&&stats.screenshot.max<=5000,'screenshot latency');
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
  for(let i=1;i<=3;i++){const rootScroll=await computer('scroll',{...xy(400,150),delta:200});assert.equal(rootScroll.pageY,i*200);}
  await computer('hover',xy(400,150));
  const scrollY=await worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>scrollY});return r.result;},tabId);assert.equal(scrollY,600);
  await worker.evaluate(()=>{(globalThis as any).fixtureCaptureHang=true;});
  const retryAt=performance.now();
  const retryShot=await computer('screenshot');
  const retryMs=Math.round(performance.now()-retryAt);
  assert.ok(retryShot.width>300&&retryShot.height>300&&retryMs<=5000);
  console.log('HIDDEN_CHROME_CAPTURE_RETRY '+JSON.stringify({ms:retryMs,width:retryShot.width,height:retryShot.height}));
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
  // All seven new tools use the same temporary profile and foreground sampler.
  const extra:Record<string,number[]>={};
  const timed=async(name:string,args:any)=>{
    assert.equal(await currentVisibility(),'hidden');const at=performance.now();
    const result=await run(name,{tabId,...args});(extra[name]??=[]).push(Math.round(performance.now()-at));
    assert.equal(await currentVisibility(),'hidden');return result;
  };
  const base='http://127.0.0.1:'+server.port+'/';
  const ownedTab=await run('open',{url:base});await Bun.sleep(300);
  await assert.rejects(run('go',{tabId:ownedTab.tabId,action:'back'}),/pc_chrome_rejected/);
  const userTab=await worker.evaluate(async url=>(globalThis as any).chrome.tabs.create({url,active:false}),base);await Bun.sleep(300);
  await assert.rejects(run('close',{tabId:userTab.id}),/pc_chrome_rejected/);
  await timed('close',{tabId:ownedTab.tabId});await timed('close',{tabId:userTab.id,userTab:true});
  assert.ok(!(await run('tabs')).windows.flatMap((w:any)=>w.tabs).some((t:any)=>[ownedTab.tabId,userTab.id].includes(t.tabId)));
  await run('navigate',{tabId,url:base+'?history=2'});await Bun.sleep(500);
  const pageUrl=async()=>worker.evaluate(async id=>{const [r]=await (globalThis as any).chrome.scripting.executeScript({target:{tabId:id},func:()=>location.href});return r.result;},tabId);
  await timed('go',{action:'back'});await Bun.sleep(500);assert.equal(await pageUrl(),base);
  await timed('go',{action:'forward'});await Bun.sleep(500);assert.equal(await pageUrl(),base+'?history=2');
  await timed('js',{code:'globalThis.reloadProbe=123'});await timed('go',{action:'reload'});await Bun.sleep(500);
  assert.equal(JSON.parse((await timed('js',{code:'typeof globalThis.reloadProbe'})).json),'undefined');
  const fixtureHtml='<div style="position:absolute;top:450px;left:30px"><select aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select><select aria-label="Multiple choices" multiple><option value="a">Alpha</option><option value="b">Beta</option></select><input type="checkbox" aria-label="Check me"><input type="radio" aria-label="Radio me"><input type="date" aria-label="Date me"><input type="file" aria-label="Direct file"><input id="hiddenFile" type="file" style="display:none"><button aria-label="Choose file" onclick="document.getElementById(\'hiddenFile\').click()">Choose file</button></div>';
  await timed('js',{code:'document.body.insertAdjacentHTML("beforeend",'+JSON.stringify(fixtureHtml)+');globalThis.formEvents=[];for(const name of ["input","change"])document.addEventListener(name,e=>formEvents.push(name+":"+e.target.getAttribute("aria-label")));true'});
  const findRef=async(query:string)=>(await run('find',{tabId,query})).nodes[0].ref;
  for(const [name,value] of [['Choice','Beta'],['Multiple choices',['a','b']],['Check me',true],['Radio me',true],['Date me','2026-11-18']] as const)await timed('form',{ref:await findRef(name),value});
  const formResult=JSON.parse((await timed('js',{code:'({values:[...document.querySelectorAll("select")].map(x=>[...x.selectedOptions].map(o=>o.value)),checked:document.querySelector("[type=checkbox]").checked,radio:document.querySelector("[type=radio]").checked,date:document.querySelector("[type=date]").value,events:formEvents})'})).json);
  assert.deepEqual(formResult.values,[['b'],['a','b']]);assert.equal(formResult.checked,true);assert.equal(formResult.radio,true);assert.equal(formResult.date,'2026-11-18');assert.equal(formResult.events.length,10);
  const file=join(root,'upload-fixture.txt');writeFileSync(file,'fixture upload');
  for(const name of ['Direct file','Choose file']){
    const uploaded=await timed('upload',{ref:await findRef(name),paths:[file]});assert.deepEqual(uploaded.files,[{name:'upload-fixture.txt',size:14}]);
  }
  const fileState=JSON.parse((await timed('js',{code:'[...document.querySelectorAll("input[type=file]")].map(e=>[...e.files].map(f=>({name:f.name,size:f.size})))'})).json);
  assert.deepEqual(fileState,[[{name:'upload-fixture.txt',size:14}],[{name:'upload-fixture.txt',size:14}]]);
  const labelsHtml='<div style="position:absolute;top:650px;left:30px"><label>Label choice<select aria-label="label-select"><option value="a">Alpha</option><option value="b">Beta</option></select></label><label for="labelCheck">Label check</label><input id="labelCheck" type="checkbox" aria-label="label-check"><label>Label radio<input type="radio" aria-label="label-radio"></label><label for="labelDate">Label date</label><input id="labelDate" type="date" aria-label="label-date"><label>Label text<input aria-label="label-text"></label><label for="labelFile">Label file</label><input id="labelFile" type="file" aria-label="label-file"></div>';
  await timed('js',{code:'document.body.insertAdjacentHTML("beforeend",'+JSON.stringify(labelsHtml)+');formEvents.length=0;true'});
  const findLabel=async(name:string,control:string)=>{
    const found=await run('find',{tabId,query:name});const label=found.nodes.find((n:any)=>n.role==='label'&&n.name.includes(name));assert.equal(label?.control,control);return label.ref;
  };
  const tree=await run('read',{tabId,mode:'tree'});assert.ok(tree.nodes.some((n:any)=>n.role==='label'&&n.name.includes('Label choice')&&n.control==='select'));
  const labelDurations:Record<string,number[]>={form:[],upload:[]};
  for(const [name,control,value,expected] of [['Label choice','select','Beta','b'],['Label choice','select','a','a'],['Label check','checkbox',true,true],['Label radio','radio',true,true],['Label date','date','2026-11-18','2026-11-18'],['Label text','text','hello','hello']] as const){
    const ref=await findLabel(name,control);const result=await timed('form',{ref,value});assert.equal(result.via,'label');assert.equal(result.value,expected);labelDurations.form.push(extra.form.at(-1)!);
  }
  await worker.evaluate(()=>{const c=(globalThis as any).chrome;const send=c.debugger.sendCommand;c.debugger.sendCommand=(...args:any[])=>{if(args[1]==='Page.setInterceptFileChooserDialog'||args[1]==='Input.dispatchMouseEvent')throw Error('Label upload must not intercept or click');return send(...args);};});
  const labelUpload=await timed('upload',{ref:await findLabel('Label file','file'),paths:[file]});assert.equal(labelUpload.via,'label');assert.deepEqual(labelUpload.files,[{name:'upload-fixture.txt',size:14}]);labelDurations.upload.push(extra.upload.at(-1)!);
  const labelState=JSON.parse((await timed('js',{code:'({values:[...document.querySelectorAll("[aria-label^=label-]")].map(e=>e.type==="file"?[...e.files].map(f=>({name:f.name,size:f.size})):e.type==="checkbox"||e.type==="radio"?e.checked:e.value),events:formEvents})'})).json);
  assert.deepEqual(labelState.values,['a',true,true,'2026-11-18','hello',[{name:'upload-fixture.txt',size:14}]]);
  for(const name of ['select','check','radio','date','text','file'])assert.ok(labelState.events.includes('change:label-'+name),name+' change missing');
  console.log('OWN_CHROME_LABEL_OK '+JSON.stringify({labelDurations,labelState,chooserIntercepted:false}));
  await timed('console',{clear:true});await timed('network',{});
  await timed('js',{code:'console.error("fixture-console-error"); fetch("/?token=fixture-secret",{headers:{"X-Test-Token":"fixture-secret"}}).then(r=>r.text()).then(t=>t.length)'});
  await Bun.sleep(300);
  assert.ok((await timed('console',{onlyErrors:true,pattern:'fixture-console-error'})).entries.length>0);
  const network=await timed('network',{urlPattern:'token='});assert.ok(network.entries.length>0);assert.match(JSON.stringify(network),/REDACTED/);assert.doesNotMatch(JSON.stringify(network),/fixture-secret/);
  const response=await timed('network',{requestId:network.entries.at(-1).requestId});assert.match(response.body,/Fixture PC2/);
  console.log('OWN_CHROME_EXTRA_OK '+JSON.stringify({durationsMs:extra,formResult,fileState,networkMasked:true}));
  const end=Date.now(),expected=readFileSync(ready,'utf8').trim();
  const samples=readFileSync(join(root,'foreground.csv'),'utf8').trim().split(/\r?\n/).map(l=>l.split(',')).filter(r=>Number(r[0])>=start&&Number(r[0])<=end);
  assert.ok(samples.length>=5);assert.equal(samples.filter(r=>r[1]!==expected).length,0,'foreground changed');
  console.log(JSON.stringify({result:'OWN_CHROME_SMOKE_OK',samples:samples.length,foregroundChanges:0,cursor:true,canvas:true,typed:true,activeTabUnchanged:true,scrollY,timeoutRecovery:true,idleDetached:true,medianMs:median,durationsMs:durations,profile:root}));
  assert.ok(Object.values(median).every(ms=>ms<=1500),'median latency target exceeded: '+JSON.stringify(median));
  }
}finally{
  if(focus){writeFileSync(join(root,'foreground-stop'),'stop');await focus.exited;}
  if(socket){await Promise.race([cdp('Browser.close').catch(()=>{}),Bun.sleep(1500)]);socket.close();if(chromeProcess.exitCode===null)chromeProcess.kill();}
  else chromeProcess.kill();
  await chromeProcess.exited;server.stop();
}
} finally {
  removeSmokeDirectory(root);
}
