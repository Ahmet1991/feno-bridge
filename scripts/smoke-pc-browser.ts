import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPcBrowser,readBrowserEndpoint} from '../src/pc-control/browser';

const directory=mkdtempSync(join(tmpdir(),'feno-pc-browser-smoke-'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(`<!doctype html><html><body><h1>PC2 fixture</h1><label>Name <input id="name" oninput="document.getElementById('typed').textContent=this.value"></label><button onclick="document.getElementById('result').textContent='Saved '+document.getElementById('name').value">Save</button><p id="typed"></p><p id="result"></p></body></html>`,{headers:{'content-type':'text/html; charset=utf-8'}})});
const browser=createPcBrowser({directory});
const run=(action:string,args:Record<string,unknown>={})=>browser.run(action,args,new AbortController().signal);
try{
  const {tabId}=await run('open',{url:`http://127.0.0.1:${server.port}/`});
  let page='';
  for(let i=0;i<25;i++){
    page=(await run('read',{tabId,mode:'text'})).text;
    if(page.includes('PC2 fixture'))break;
    await Bun.sleep(200);
  }
  if(!page.includes('PC2 fixture'))throw new Error('Fixture not loaded: '+page);
  const ref=async(query:string)=>JSON.parse((await run('find',{tabId,query})).text.trim().split('\n')[0]).ref;
  await run('type',{tabId,ref:await ref('Name'),text:'smoke-ok'});
  const typed=(await run('read',{tabId,mode:'text'})).text;
  if(!typed.includes('smoke-ok'))throw new Error('Typing not received: '+typed);
  await run('click',{tabId,ref:await ref('Save')});
  const result=(await run('read',{tabId,mode:'text'})).text;
  if(!result.includes('Saved smoke-ok'))throw new Error('Unexpected result: '+result);
  const shot=await run('screenshot',{tabId});
  if(shot.data.length<100||shot.data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Invalid PNG');
  writeFileSync(join(directory,'smoke.png'),shot.data);
  console.log(JSON.stringify({result:'BROWSER_SMOKE_OK',text:result,pngBytes:shot.data.length,directory}));
}catch(error){
  console.error('Fixture tabs:',JSON.stringify(await run('tabs').catch(()=>null)));
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
}
