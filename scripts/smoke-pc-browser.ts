import {mkdtempSync,writeFileSync,readFileSync,existsSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPcBrowser,readBrowserEndpoint} from '../src/pc-control/browser';

const directory=mkdtempSync(join(tmpdir(),'feno-pc-browser-smoke-'));
const cache=join(import.meta.dir,'..','.cache');
if(process.platform==='win32'){
  const compiler= ['Framework64','Framework'].map(folder=>join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET',folder,'v4.0.30319','csc.exe')).find(existsSync);
  if(!compiler)throw new Error('Foreground probe compiler not found');
  const built=Bun.spawnSync([compiler,'/nologo','/target:library','/out:'+join(cache,'sample-browser-foreground.dll'),'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',join(import.meta.dir,'sample-browser-foreground.cs')],{stdout:'inherit',stderr:'inherit'});
  if(built.exitCode!==0)throw new Error('Foreground probe build failed');
  copyFileSync(join(import.meta.dir,'..','launcher','electron','pc-windows-helper.sha256'),join(cache,'pc-windows-helper.sha256'));
  // Source-build helper only, never the installed/live helper.
  process.env.FENO_PC_HELPER_ROOT=cache;
}
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(`<!doctype html><html><head><title>PC2 fixture</title></head><body><h1>PC2 fixture</h1><form onsubmit="event.preventDefault()"><label>Search <input type="search" id="name" oninput="document.getElementById('typed').textContent=this.value"></label><label>Password <input type="password"></label><label>Card <input autocomplete="cc-number"></label><button type="button" onclick="document.getElementById('result').textContent='Saved '+document.getElementById('name').value">Save</button></form><p id="typed"></p><p id="result"></p><p id="highlight">Highlight 0/0</p><script>let adds=0,removes=0;new MutationObserver(records=>{for(const record of records){for(const n of record.addedNodes)if(n.nodeType===1&&n.hasAttribute('data-feno-pc-highlight'))adds++;for(const n of record.removedNodes)if(n.nodeType===1&&n.hasAttribute('data-feno-pc-highlight'))removes++;}document.getElementById('highlight').textContent='Highlight '+adds+'/'+removes;}).observe(document.documentElement,{childList:true});</script></body></html>`,{headers:{'content-type':'text/html; charset=utf-8'}})});
const browser=createPcBrowser({directory});
const steps:{action:string;start:number;end:number}[]=[];
const run=async(action:string,args:Record<string,unknown>={})=>{
  const start=Date.now();
  let result:any;
  try{result=await browser.run(action,{timeoutSeconds:20,...args},new AbortController().signal);}
  catch(error){console.error('Smoke action failed:',action,'elapsedMs:',Date.now()-start,'directory:',directory);throw error;}
  await Bun.sleep(220);
  steps.push({action,start,end:Date.now()});
  return result;
};
const focus=process.platform==='win32'?Bun.spawn(['powershell.exe','-NoProfile','-Sta','-Command','Add-Type -Path $env:FENO_FOCUS_PROBE; [ForegroundProbe]::Run($env:FENO_FOCUS_DIRECTORY)'],{
  windowsHide:true,stdout:'inherit',stderr:'inherit',env:{...process.env,FENO_FOCUS_PROBE:join(import.meta.dir,'..','.cache','sample-browser-foreground.dll'),FENO_FOCUS_DIRECTORY:directory}
}):undefined;
const ready=join(directory,'foreground-ready');
const counts:any[]=[];
async function browserCdp(method:string,params:Record<string,unknown>={}){
  const endpoint=readBrowserEndpoint(directory);
  if(!endpoint)throw new Error('Missing fixture CDP endpoint');
  const ws=new WebSocket(endpoint);
  try{return await new Promise<any>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Fixture CDP timeout: '+method)),5000);
    ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method,params})),{once:true});
    ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id!==1)return;clearTimeout(timeout);m.error?reject(new Error(method+': '+m.error.message)):resolve(m.result);});
    ws.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('Fixture CDP connection failed'));},{once:true});
  });}finally{ws.close();}
}
const urls=async()=>((await run('tabs')).tabs as {url:string}[]).map(t=>t.url).sort();
const sameUrls=(before:string[],after:string[])=>{
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('URL list not preserved: '+JSON.stringify({before,after}));
};
function sample(mode:string,start:number,end:number){
  if(!focus)return;
  const expected=readFileSync(ready,'utf8').trim();
  const rows=readFileSync(join(directory,'foreground.csv'),'utf8').trim().split(/\r?\n/).map(line=>line.split(',')).filter(row=>Number(row[0])>=start&&Number(row[0])<=end);
  const changed=rows.filter(row=>row[1]!==expected);
  counts.push({mode,samples:rows.length,foregroundChanges:changed.length,chromeSamples:rows.filter(row=>/^(chrome|msedge)$/i.test(row[3])).length,
    unexpected:changed.slice(0,10),steps:steps.filter(s=>s.start>=start&&s.end<=end).map(s=>({action:s.action,samples:rows.filter(r=>Number(r[0])>=s.start&&Number(r[0])<=s.end).length,changed:changed.filter(r=>Number(r[0])>=s.start&&Number(r[0])<=s.end).length}))});
}
async function exercise(mode:string){
  const start=Date.now();
  const target=`http://127.0.0.1:${server.port}/`;
  if(mode==='hidden'){
    const before=await urls();
    await run('mode',{mode:'hidden'});
    sameUrls(before,await urls());
  }
  const {tabId}=await run('open',{url:target});
  const version=await browserCdp('Browser.getVersion');
  if(version.userAgent.includes('HeadlessChrome')!==(mode==='hidden'))throw new Error('Unexpected Chrome mode');
  if(mode==='visible'){
    const {bounds}=await browserCdp('Browser.getWindowForTarget',{targetId:tabId});
    if(bounds.windowState!=='normal'||bounds.width<=0||bounds.height<=0)throw new Error('Unexpected visible window bounds: '+JSON.stringify(bounds));
  }
  let page='';
  for(let i=0;i<25;i++){
    page=(await run('read',{tabId,mode:'text'})).text;
    if(page.includes('PC2 fixture'))break;
    await Bun.sleep(200);
  }
  if(!page.includes('PC2 fixture'))throw new Error('Fixture not loaded: '+page);
  const ref=async(query:string)=>JSON.parse((await run('find',{tabId,query})).text.trim().split('\n')[0]).ref;
  const search=await run('type',{tabId,ref:await ref('Search'),text:'smoke-ok',submit:true});
  if(search.warning)throw new Error('Search falsely classified as sensitive');
  for(const query of ['Password','Card']){
    const result=await run('type',{tabId,ref:await ref(query),text:'fixture-only'});
    if(!result.warning)throw new Error(query+' not classified as sensitive');
  }
  const typed=(await run('read',{tabId,mode:'text'})).text;
  if(!typed.includes('smoke-ok'))throw new Error('Typing not received: '+typed);
  await run('click',{tabId,ref:await ref('Save')});
  const result=(await run('read',{tabId,mode:'text'})).text;
  if(!result.includes('Saved smoke-ok'))throw new Error('Unexpected result: '+result);
  const shot=await run('screenshot',{tabId,timeoutSeconds:10});
  if(shot.data.length<100||shot.data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Invalid PNG');
  writeFileSync(join(directory,'smoke-'+mode+'.png'),shot.data);
  if(!(await run('tabs')).tabs.some((t:any)=>t.tabId===tabId&&t.title==='PC2 fixture'))throw new Error('Title changed');
  await Bun.sleep(1100);
  const highlight=(await run('read',{tabId,mode:'text'})).text;
  if(!highlight.includes(mode==='visible'?'Highlight 4/4':'Highlight 0/0'))throw new Error('Unexpected highlight lifecycle: '+highlight);
  // Leave one fixture URL open across the mode switch.
  if(mode==='visible'){
    const second=await run('open',{url:target});
    const extra=await run('screenshot',{tabId:second.tabId,timeoutSeconds:10});
    if(extra.data.length<100)throw new Error('Second background window screenshot failed');
  }
  await run('close_tab',{tabId});
  await Bun.sleep(500);
  sample(mode,start,Date.now());
  console.log(JSON.stringify({mode,result:'BROWSER_SMOKE_OK',product:version.product,text:result,pngBytes:shot.data.length,highlight:mode==='visible'?'4 added / 4 removed':'0 added / 0 removed',directory}));
}
try{
  if(focus){
    for(let i=0;i<100&&!existsSync(ready);i++)await Bun.sleep(100);
    if(!existsSync(ready))throw new Error('Foreground fixture did not acquire focus');
  }
  await exercise('visible');
  await exercise('hidden');
  const transition=Date.now();
  const before=await urls();
  await run('mode',{mode:'visible'});
  sameUrls(before,await urls());
  await Bun.sleep(500);
  sample('hidden-to-visible',transition,Date.now());
  console.log(JSON.stringify({focus:counts}));
  if(counts.some(c=>c.samples===0||c.foregroundChanges!==0))throw new Error('Foreground focus changed');
}catch(error){
  if(readBrowserEndpoint(directory))console.error('Fixture tabs:',JSON.stringify(await run('tabs').catch(()=>null)));
  throw error;
}finally{
  // Close only the browser started for this unique test profile.
  const endpoint=readBrowserEndpoint(directory);
  if(endpoint){
    const ws=new WebSocket(endpoint);
    await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>{ws.close();resolve();},2000);
      ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method:'Browser.close'})),{once:true});
      ws.addEventListener('close',()=>{clearTimeout(timer);resolve();},{once:true});
      ws.addEventListener('error',()=>{clearTimeout(timer);resolve();},{once:true});
    });
  }
  browser.disconnect();server.stop(true);
  if(focus){writeFileSync(join(directory,'foreground-stop'),'stop');await focus.exited;}
}
