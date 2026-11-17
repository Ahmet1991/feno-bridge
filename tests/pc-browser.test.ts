import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createPcBrowser,validateBrowserUrl,readBrowserEndpoint,PC_BROWSER_WARNING,startBrowserProxy} from '../src/pc-control/browser';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {registerPcTools,type PcHost} from '../src/pc-control/mcp-tools';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

test('fake CDP websocket: launch, port, tabs, read, input, screenshot, stale ref and timeout',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'pc-browser-test-'));
  const calls:any[]=[];let page='about:blank',started=0,typed='';
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,server){return server.upgrade(req)?undefined:new Response('bad',{status:400});},
    websocket:{message(ws,raw){
      const msg=JSON.parse(String(raw));calls.push(msg);let result:any={};
      switch(msg.method){
        case 'Target.getTargets':result={targetInfos:[{targetId:'t1',type:'page',url:page,title:'Fixture'}]};break;
        case 'Target.createTarget':result={targetId:'t1'};break;
        case 'Target.attachToTarget':result={sessionId:'s1'};break;
        case 'Page.navigate':page=msg.params.url;break;
        case 'Accessibility.getFullAXTree':result={nodes:[{backendDOMNodeId:1,role:{value:'textbox'},name:{value:'Name'}},{backendDOMNodeId:2,role:{value:'button'},name:{value:'Save'}}]};break;
        case 'Runtime.evaluate':result={result:{value:'Fixture '+typed}};break;
        case 'DOM.resolveNode':result={object:{objectId:'node'}};break;
        case 'Runtime.callFunctionOn':result={result:{value:{x:10,y:20,sensitive:true}}};break;
        case 'Input.insertText':typed=msg.params.text;break;
        case 'Page.captureScreenshot':result={data:'iVBORw0KGgo='};break;
        case 'Page.reload':break;
        case 'Browser.getWindowForTarget':result={windowId:1};break;
        case 'Page.getNavigationHistory':result={currentIndex:1,entries:[{id:1,url:'about:blank'},{id:2,url:page}]};break;
        case 'Target.closeTarget':result={success:true};break;
        case 'Page.enable':break;
      }
      if(msg.method==='Runtime.evaluate'&&typed==='timeout')return;
      ws.send(JSON.stringify({id:msg.id,result}));
    }}});
  const b=createPcBrowser({directory,resolveBrowser:()=> 'chrome.exe',startBrowser:(_,args)=>{
    started++;expect(args).toContain('--start-minimized');expect(args).toContain('--remote-debugging-port=0');
    expect(args.some(a=>a.startsWith('--proxy-server='))).toBe(true);
    writeFileSync(join(directory,'DevToolsActivePort'),server.port+'\n/devtools/browser/fixture');
  }});
  const run=(action:string,args:any={})=>b.run(action,args,new AbortController().signal);
  try{
    const {tabId}=await run('open',{url:'http://127.0.0.1:1234/'});
    expect(tabId).toBe('t1');expect(started).toBe(1);
    expect(readBrowserEndpoint(directory)).toContain('127.0.0.1:'+server.port);
    expect((await run('tabs')).tabs[0].tabId).toBe(tabId);
    const tree=await run('read',{tabId,mode:'tree'});
    expect(tree.warning).toBe(PC_BROWSER_WARNING);
    const ref=JSON.parse(tree.text.split('\n')[0]).ref;
    expect(await run('type',{tabId,ref,text:'test-secret'})).toMatchObject({warning:'Kullanıcı onayı gerektiren işlem'});
    expect((await run('read',{tabId,mode:'text'})).text).toContain('test-secret');
    const found=await run('find',{tabId,query:'Save'});
    expect(await run('click',{tabId,ref:JSON.parse(found.text.trim()).ref})).toMatchObject({ok:true});
    expect((await run('screenshot',{tabId})).data.length).toBe(8);
    await run('reload',{tabId});await expect(run('click',{tabId,ref})).rejects.toMatchObject({code:'pc_browser_ref_stale'});
    await expect(run('navigate',{tabId,url:'file:///C:/secret'})).rejects.toMatchObject({code:'pc_browser_url_blocked'});
    await expect(run('read',{tabId:'missing',mode:'text'})).rejects.toMatchObject({code:'pc_browser_tab_not_found'});
    await run('hide');await run('show');await run('back',{tabId});
    expect(calls.some(c=>c.method==='Target.activateTarget'||c.method==='Page.bringToFront')).toBe(false);
    expect(calls.filter(c=>c.method==='Input.dispatchMouseEvent')).toHaveLength(2);
    const next=await run('read',{tabId,mode:'tree'});
    await run('type',{tabId,ref:JSON.parse(next.text.split('\n')[0]).ref,text:'timeout'});
    await expect(run('read',{tabId,mode:'text',timeoutSeconds:1})).rejects.toMatchObject({code:'pc_browser_timeout'});
  }finally{b.disconnect();server.stop(true);}
},15000);

test('proxy denies local IP, DNS rebinding targets and disallowed schemes; permits loopback HTTP only',async()=>{
  const resolve=async()=>['192.168.1.2'];
  for(const url of ['file:///C:/x','chrome://settings','devtools://devtools','http://10.0.0.1','http://169.254.169.254','http://192.168.0.1','http://[::1]','https://localhost','http://local.test'])
    await expect(validateBrowserUrl(url,resolve)).rejects.toMatchObject({code:'pc_browser_url_blocked'});
  expect(await validateBrowserUrl('http://localhost:1234')).toBe('http://localhost:1234/');
  const dir=mkdtempSync(join(tmpdir(),'pc-proxy-test-'));
  const proxy=await startBrowserProxy(dir,resolve,new AbortController().signal);
  try{
    const status=(path:string)=>new Promise<number|undefined>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:proxy.port,path},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
    });
    expect(await status('http://192.168.1.2/')).toBe(403);
    expect(await status('http://local.test/')).toBe(403);
    expect(await status('http://127.0.0.1:'+proxy.port+'/')).toBe(403);
    const local=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('ok')});
    try{expect(await status('http://127.0.0.1:'+local.port+'/')).toBe(200);}finally{local.stop(true);}
  }finally{proxy.close();}
});

test('browser audit stores field names only, including denied calls',async()=>{
  const auth=new PcAuthorizer({profileId:'pc2-normal'});
  auth.setGrantFromLocalApproval({profileId:'pc2-normal',id:'browser-test',expiresAt:null,roots:[],allowedApps:[],permissions:['browser']});
  const callbacks=new Map<string,any>(),records:unknown[]=[];
  const server={registerResource(){},registerTool(name:string,options:unknown,fn:any){callbacks.set(name,fn);}} as unknown as McpServer;
  registerPcTools(server,{authorizer:auth,host:{browser:async()=>({text:'secret-output'})} as unknown as PcHost,auditTool:r=>{records.push(r);}});
  await callbacks.get('pc_browser_type')({tabId:'tab',ref:'ref_1',text:'secret-input'});
  auth.revoke();await callbacks.get('pc_browser_open')({url:'http://secret-url'});
  expect(records).toMatchObject([{tool:'pc_browser_type',outcome:'ok',fields:['ref','tabId','text']},{tool:'pc_browser_open',outcome:'error',fields:['url']}]);
  expect(JSON.stringify(records)).not.toContain('secret');
});
