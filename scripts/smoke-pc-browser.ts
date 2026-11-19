import {mkdtempSync,writeFileSync,readFileSync,existsSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPcBrowser,readBrowserEndpoint} from '../src/pc-control/browser';
import sharp from 'sharp';

const directory=mkdtempSync(join(tmpdir(),'feno-pc-browser-smoke-'));
const hiddenOnly=process.argv.includes('--hidden-only');
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
const fixture=`<!doctype html><html><head><title>PC2 fixture</title></head><body><h1>PC2 fixture</h1><form onsubmit="event.preventDefault()"><label>Search <input type="search" id="name" oninput="document.getElementById('typed').textContent=this.value"></label><label>Password <input type="password"></label><label>Card <input autocomplete="cc-number"></label><button type="button" onclick="document.getElementById('result').textContent='Saved '+document.getElementById('name').value">Save</button></form><p id="typed"></p><p id="result"></p><p id="highlight">Highlight 0/0</p>
<canvas id="canvas" width="300" height="160" style="position:absolute;left:40px;top:220px;width:300px;height:160px;background:#edf2fa;touch-action:none"></canvas>
<input id="coordinate" aria-label="Coordinate input" style="position:absolute;left:40px;top:400px;width:240px;height:28px"><p style="position:absolute;left:40px;top:445px" id="coordinate-result"></p><p style="position:absolute;left:40px;top:480px" id="metrics"></p><p style="position:absolute;left:40px;top:510px" id="events"></p>
<script>let adds=0,removes=0;new MutationObserver(records=>{for(const record of records){for(const n of record.addedNodes)if(n.nodeType===1&&n.hasAttribute('data-feno-pc-highlight'))adds++;for(const n of record.removedNodes)if(n.nodeType===1&&n.hasAttribute('data-feno-pc-highlight'))removes++;}document.getElementById('highlight').textContent='Highlight '+adds+'/'+removes;}).observe(document.documentElement,{childList:true});
const canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d'),events=document.getElementById('events'),state={};let down=null;
const xy=e=>{const r=canvas.getBoundingClientRect();return [Math.round(e.clientX-r.left),Math.round(e.clientY-r.top)]};
const record=(name,value)=>{state[name]=value;events.textContent='Events '+JSON.stringify(state)};
canvas.addEventListener('pointerdown',e=>{if(e.button===0){down=xy(e);canvas.setPointerCapture(e.pointerId)}});
canvas.addEventListener('pointermove',e=>{record('hover',xy(e));if(down&&e.buttons===1){ctx.fillStyle='#2563eb';ctx.fillRect(...xy(e),3,3)}});
canvas.addEventListener('pointerup',e=>{if(down){record('drag',[down,xy(e)]);down=null;}});
canvas.addEventListener('click',e=>{record('click',xy(e));ctx.fillStyle='#162b50';ctx.fillRect(...xy(e),5,5)});
canvas.addEventListener('dblclick',e=>record('double',xy(e)));
canvas.addEventListener('contextmenu',e=>{e.preventDefault();record('right',xy(e))});
canvas.addEventListener('wheel',e=>{e.preventDefault();record('wheel',[e.deltaX,e.deltaY])},{passive:false});
document.getElementById('coordinate').addEventListener('input',e=>document.getElementById('coordinate-result').textContent='Coordinate '+e.target.value);
const metrics=()=>document.getElementById('metrics').textContent='Metrics '+innerWidth+'/'+innerHeight+'/'+devicePixelRatio;metrics();addEventListener('resize',metrics);
</script></body></html>`;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(fixture,{headers:{'content-type':'text/html; charset=utf-8'}})});
const browser=createPcBrowser({directory});
const steps:{action:string;start:number;end:number}[]=[];
const run=async(action:string,args:Record<string,unknown>={})=>{
  const start=Date.now();
  let result:any;
  try{result=await browser.run(action,{timeoutSeconds:20,...args},new AbortController().signal);}
  catch(error){console.error('Smoke action failed:',action,'elapsedMs:',Date.now()-start,'directory:',directory);throw error;}
  await Bun.sleep(220);
  steps.push({action:action==='computer'?'computer:'+args.action:action,start,end:Date.now()});
  return result;
};
const focus=process.platform==='win32'?Bun.spawn(['powershell.exe','-NoProfile','-Sta','-Command',hiddenOnly?'Add-Type -Path $env:FENO_FOCUS_PROBE; [ForegroundProbe]::RunPassive($env:FENO_FOCUS_DIRECTORY)':'Add-Type -Path $env:FENO_FOCUS_PROBE; [ForegroundProbe]::Run($env:FENO_FOCUS_DIRECTORY)'],{
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
    if(hiddenOnly)await run('mode',{mode:'hidden'});
    else{
      const before=await urls();
      await run('mode',{mode:'hidden'});
      sameUrls(before,await urls());
    }
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
  const metrics=/Metrics (\d+)\/(\d+)\/([\d.]+)/.exec(highlight);
  if(!metrics)throw new Error('Missing fixture viewport: '+highlight);
  const cssWidth=Number(metrics[1]),cssHeight=Number(metrics[2]);
  const pngWidth=shot.data.readUInt32BE(16),pngHeight=shot.data.readUInt32BE(20);
  const point=(x:number,y:number)=>({x:Math.round(x*pngWidth/cssWidth),y:Math.round(y*pngHeight/cssHeight)});
  const computer=(action:string,args:Record<string,unknown>={})=>run('computer',{tabId,action,...args});
  const events=async()=>{const read=(await run('read',{tabId,mode:'text'})).text;const line=read.split('\n').find((l:string)=>l.startsWith('Events '));if(!line)throw new Error('Missing canvas event: '+read);return JSON.parse(line.slice(7));};
  const matches=(actual:number[],expected:number[])=>actual?.length===expected.length&&actual.every((v,i)=>Math.abs(v-expected[i])<=1);
  await computer('click',point(100,260));
  if(!matches((await events()).click,[60,40]))throw new Error('Canvas click was not delivered at expected coordinates');
  const dragStart=point(75,245),dragEnd=point(270,350);
  await computer('drag',{...dragStart,endX:dragEnd.x,endY:dragEnd.y});
  const drag=(await events()).drag;
  if(!matches(drag?.[0],[35,25])||!matches(drag?.[1],[230,130]))throw new Error('Canvas drag was not delivered: '+JSON.stringify(drag));
  await computer('double_click',point(170,280));
  if(!matches((await events()).double,[130,60]))throw new Error('Double click was not delivered');
  await computer('right_click',point(145,300));
  if(!matches((await events()).right,[105,80]))throw new Error('Right click was not delivered');
  await computer('scroll',{...point(145,300),delta:120,deltaX:20});
  if(!matches((await events()).wheel,[20,120]))throw new Error('Wheel was not delivered');
  const coordinateType=await computer('type',{...point(100,415),text:'coordinate-ok!'});
  if(coordinateType.warning)throw new Error('Coordinate normal input misclassified');
  await computer('key',{key:'BACKSPACE'});
  if(!(await run('read',{tabId,mode:'text'})).text.includes('Coordinate coordinate-ok'))throw new Error('Coordinate typing/key failed');
  await computer('hover',point(250,300));
  if(!matches((await events()).hover,[210,80]))throw new Error('Hover was not delivered');
  const cropped=async(data:Buffer)=>sharp(data).extract({left:point(250,300).x,top:point(250,300).y,width:Math.min(20,pngWidth-point(250,300).x),height:20}).raw().toBuffer();
  const shown=await computer('screenshot',{includeCursor:true}),clean=await computer('screenshot',{includeCursor:false});
  const hasCursor=!(await cropped(shown.data)).equals(await cropped(clean.data));
  if(hasCursor!==(mode==='visible'))throw new Error('Unexpected cursor screenshot comparison: '+hasCursor);
  await run('reload',{tabId});
  let reloaded='';for(let i=0;i<20;i++){reloaded=(await run('read',{tabId,mode:'text'})).text;if(reloaded.includes('Metrics ')&&!reloaded.includes('Coordinate coordinate-ok'))break;}
  if(!reloaded.includes('Metrics ')||reloaded.includes('Coordinate coordinate-ok'))throw new Error('Reload not confirmed');
  const afterReload=await computer('screenshot',{includeCursor:true}),afterClean=await computer('screenshot');
  if((!(await cropped(afterReload.data)).equals(await cropped(afterClean.data)))!==(mode==='visible'))throw new Error('Cursor did not restore after navigation');
  // Leave one fixture URL open across the mode switch.
  if(mode==='visible'){
    const second=await run('open',{url:target});
    const extra=await run('screenshot',{tabId:second.tabId,timeoutSeconds:10});
    if(extra.data.length<100)throw new Error('Second background window screenshot failed');
  }
  await run('close_tab',{tabId});
  await Bun.sleep(500);
  sample(mode,start,Date.now());
  console.log(JSON.stringify({mode,result:'BROWSER_SMOKE_OK',product:version.product,text:result,pngBytes:shot.data.length,highlight:mode==='visible'?'4 added / 4 removed':'0 added / 0 removed',coordinate:{canvasClick:[60,40],drag,doubleClick:[130,60],rightClick:[105,80],wheel:[20,120],hover:[210,80],typed:'coordinate-ok',screenshot:[pngWidth,pngHeight],css:[cssWidth,cssHeight],dpr:Number(metrics[3]),cursorIncluded:hasCursor,cursorRestored:mode==='visible'},directory}));
}
try{
  if(focus){
    for(let i=0;i<100&&!existsSync(ready);i++)await Bun.sleep(100);
    if(!existsSync(ready))throw new Error('Foreground sampler did not become ready');
  }
  if(!hiddenOnly)await exercise('visible');
  await exercise('hidden');
  if(!hiddenOnly){
    const transition=Date.now();
    const before=await urls();
    await run('mode',{mode:'visible'});
    sameUrls(before,await urls());
    await Bun.sleep(500);
    sample('hidden-to-visible',transition,Date.now());
  }
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
