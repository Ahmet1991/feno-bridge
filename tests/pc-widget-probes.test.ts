import {expect, test} from 'bun:test';
import {Window} from 'happy-dom';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {registerPcTools, type PcHost} from '../src/pc-control/mcp-tools';
import {PC_PROBE_MCP_APP_HTML,PC_PROBE_SKYBRIDGE_HTML,PC_PROBE_MCP_APP_URI,PC_PROBE_SKYBRIDGE_URI} from '../src/pc-control/widget-probe';
import {PC_SCREENSHOT_SKYBRIDGE_HTML,PC_SCREENSHOT_SKYBRIDGE_URI} from '../src/pc-control/screenshot-widget';

function load(html:string,openai?:object){
  const win=new Window({settings:{disableJavaScriptEvaluation:false}});
  const sent:any[]=[];
  const parent={postMessage:(data:unknown)=>sent.push(data)};
  Object.defineProperty(win,'parent',{value:parent,configurable:true});
  if(openai)Object.defineProperty(win,'openai',{value:openai,configurable:true,writable:true});
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  win.document.write(html.replace(/<script>[\s\S]*?<\/script>/,''));
  win.eval(script!);
  const emit=(data:unknown)=>win.dispatchEvent(new win.MessageEvent('message',{data,source:parent as any}));
  const status=()=>win.document.getElementById('status')?.textContent||'';
  return {win,sent,emit,status};
}

test('MCP probe reports load, handshake, host response, tool-result and error',()=>{
  const {win,sent,emit,status}=load(PC_PROBE_MCP_APP_HTML);
  expect(status()).toContain('yüklendi');
  expect(status()).toContain('window.openai yok');
  expect(status()).toContain('el sıkışma gönderildi');
  expect(sent[0]).toMatchObject({method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'feno-pc-probe'}}});
  emit({jsonrpc:'2.0',id:sent[0].id,result:{protocolVersion:'2026-01-26',hostContext:{theme:'dark'}}});
  expect(sent[1].method).toBe('ui/notifications/initialized');
  expect(status()).toContain('yanıt geldi');
  emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{message:'Türkçe test kartı'}}});
  expect(status()).toContain('araç sonucu geldi');
  expect(win.document.documentElement.getAttribute('data-theme')).toBe('dark');
  (win.onerror as unknown as (message:string)=>unknown)?.('örnek hata');
  expect(status()).toContain('örnek hata');
  win.happyDOM.abort();
});

test('MCP probe repeated results and host context do not create infinite status or resize loop',()=>{
  const {win,sent,emit,status}=load(PC_PROBE_MCP_APP_HTML);
  emit({jsonrpc:'2.0',id:sent[0].id,result:{protocolVersion:'2026-01-26',hostContext:{theme:'light'}}});
  const result={jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{message:'same'}}};
  emit(result);
  const initial=status();
  const initialSizes=sent.filter(m=>m.method==='ui/notifications/size-changed').length;
  for(let i=0;i<50;i++){
    emit(result);
    emit({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'light'}});
  }
  expect(status()).toBe(initial);
  expect(sent.filter(m=>m.method==='ui/notifications/size-changed')).toHaveLength(initialSizes);
  win.happyDOM.abort();
});

test('Skybridge probe repeats globals without appending the same tool result',()=>{
  const host={toolOutput:{message:'same'}};
  const {win,status}=load(PC_PROBE_SKYBRIDGE_HTML,host);
  const initial=status();
  for(let i=0;i<50;i++)win.dispatchEvent(new win.Event('openai:set_globals'));
  expect(status()).toBe(initial);
  win.happyDOM.abort();
});

test('MCP probe retries with a protocol version explicitly offered by the host',()=>{
  const {win,sent,emit,status}=load(PC_PROBE_MCP_APP_HTML);
  emit({jsonrpc:'2.0',id:sent[0].id,error:{code:-32602,message:'version mismatch',data:{supportedVersions:['2025-06-18']}}});
  expect(sent[1]?.method).toBe('ui/initialize');
  expect(sent[1]?.params.protocolVersion).toBe('2025-06-18');
  expect(status()).toContain('el sıkışma yeniden gönderildi');
  emit({jsonrpc:'2.0',id:sent[1].id,result:{protocolVersion:'2025-06-18',hostContext:{}}});
  expect(sent[2]?.method).toBe('ui/notifications/initialized');
  win.happyDOM.abort();
});

test('Skybridge probe never initializes MCP; receives globals and errors visibly',()=>{
  const {win,sent,status}=load(PC_PROBE_SKYBRIDGE_HTML,{toolOutput:{message:'Türkçe test kartı'}});
  expect(sent).toEqual([]);
  expect(status()).toContain('yüklendi');
  expect(status()).toContain('window.openai var');
  expect(status()).toContain('araç sonucu geldi');
  expect(status()).not.toContain('el sıkışma gönderildi');
  Object.defineProperty(win,'openai',{value:{toolOutput:{message:'Türkçe test kartı 2'}},configurable:true});
  win.dispatchEvent(new win.Event('openai:set_globals'));
  expect(status()).toContain('araç sonucu geldi');
  win.happyDOM.abort();
});

test('Skybridge screenshot paints from private metadata without MCP handshake',()=>{
  const {win,sent}=load(PC_SCREENSHOT_SKYBRIDGE_HTML,{toolOutput:{title:'Not Defteri'},
    toolResponseMetadata:{mcp_tool_result:{_meta:{pcScreenshot:{dataUrl:'data:image/jpeg;base64,YWJj'}}}}});
  expect(sent).toEqual([]);
  expect(win.document.getElementById('preview')?.getAttribute('src')).toBe('data:image/jpeg;base64,YWJj');
  expect(win.document.getElementById('title')?.textContent).toBe('Not Defteri');
  win.happyDOM.abort();
});

test('Skybridge screenshot also paints after late openai:set_globals without external requests',()=>{
  const {win,sent}=load(PC_SCREENSHOT_SKYBRIDGE_HTML);
  const network:string[]=[];
  Object.defineProperty(win,'fetch',{value:()=>network.push('fetch')});
  expect(win.document.getElementById('empty')?.textContent).toContain('yükleniyor');
  Object.defineProperty(win,'openai',{value:{toolOutput:{title:'Türkçe pencere'},
    toolResponseMetadata:{_meta:{pcScreenshot:{dataUrl:'data:image/jpeg;base64,YWJj'}}}},configurable:true});
  win.dispatchEvent(new win.Event('openai:set_globals'));
  expect(win.document.getElementById('preview')?.getAttribute('src')).toBe('data:image/jpeg;base64,YWJj');
  expect(win.document.getElementById('title')?.textContent).toBe('Türkçe pencere');
  expect(network).toEqual([]);
  expect(sent).toEqual([]);
  win.happyDOM.abort();
});

test('probe MIME, tool metadata and screenshot fallback resources are independently registered',async()=>{
  const previous=process.env.FENO_PC_WIDGET_PROBES;
  process.env.FENO_PC_WIDGET_PROBES='1';
  try {
  const definitions=new Map<string,any>();
  const tools=new Map<string,()=>Promise<any>>();
  const resources=new Map<string,{definition:any;read:()=>Promise<any>}>();
  const server={registerTool:(name:string,definition:any,handler:()=>Promise<any>)=>{definitions.set(name,definition);tools.set(name,handler);},
    registerResource:(name:string,uri:string,opts:any,read:()=>Promise<any>)=>resources.set(uri,{definition:opts,read})} as unknown as McpServer;
  registerPcTools(server,{authorizer:new PcAuthorizer({profileId:'pc2-normal'}),host:{} as PcHost});
  for(const [tool,uri,mime,html] of [
    ['pc_widget_probe_mcpapp',PC_PROBE_MCP_APP_URI,'text/html;profile=mcp-app',PC_PROBE_MCP_APP_HTML],
    ['pc_widget_probe_skybridge',PC_PROBE_SKYBRIDGE_URI,'text/html+skybridge',PC_PROBE_SKYBRIDGE_HTML],
  ] as const){
    const meta=definitions.get(tool)?._meta;
    expect(meta?.['openai/outputTemplate']).toBe(uri);
    if(tool==='pc_widget_probe_mcpapp')expect(meta?.ui?.resourceUri).toBe(uri);
    else expect(meta?.ui).toBeUndefined();
    const content=(await resources.get(uri)?.read())?.contents?.[0];
    expect(content?.mimeType).toBe(mime);
    expect(content?.text).toBe(html);
    expect(content?.text).toContain('window.onerror');
    expect(content?.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=|fetch\s*\(|XMLHttpRequest|https?:\/\//);
    expect((await tools.get(tool)?.())?.structuredContent?.message).toBe('Türkçe test kartı');
  }
  expect(resources.has(PC_SCREENSHOT_SKYBRIDGE_URI)).toBe(true);
  } finally { if(previous===undefined)delete process.env.FENO_PC_WIDGET_PROBES;else process.env.FENO_PC_WIDGET_PROBES=previous; }
});

test('diagnostic tools are hidden unless explicitly opted in',()=>{
  const previous=process.env.FENO_PC_WIDGET_PROBES;
  delete process.env.FENO_PC_WIDGET_PROBES;
  const names:string[]=[];
  const server={registerTool:(name:string)=>names.push(name),registerResource:()=>{}} as unknown as McpServer;
  try{
    registerPcTools(server,{authorizer:new PcAuthorizer({profileId:'pc2-normal'}),host:{} as PcHost});
    expect(names).not.toContain('pc_widget_probe_mcpapp');
    expect(names).not.toContain('pc_widget_probe_skybridge');
    expect(names).toContain('pc_capture_screen');
  }finally{if(previous===undefined)delete process.env.FENO_PC_WIDGET_PROBES;else process.env.FENO_PC_WIDGET_PROBES=previous;}
});

test('explicit skybridge flag switches screenshots without changing either diagnostic tool',()=>{
  const before=process.env.FENO_PC_WIDGET_MODE;
  const probeBefore=process.env.FENO_PC_WIDGET_PROBES;
  process.env.FENO_PC_WIDGET_PROBES='1';
  const definitions=new Map<string,any>();
  const server={registerTool:(name:string,definition:any)=>definitions.set(name,definition),registerResource:()=>{}} as unknown as McpServer;
  try{
    process.env.FENO_PC_WIDGET_MODE='skybridge';
    registerPcTools(server,{authorizer:new PcAuthorizer({profileId:'pc2-normal'}),host:{} as PcHost});
    for(const name of ['pc_capture_screen','pc_capture_full_screen','pc_adb_screencap','pc_show_image']){
      const meta=definitions.get(name)._meta;
      expect(meta['openai/outputTemplate']).toBe(PC_SCREENSHOT_SKYBRIDGE_URI);
      expect(meta.ui).toBeUndefined();
    }
    expect(definitions.get('pc_widget_probe_mcpapp')._meta.ui.resourceUri).toBe(PC_PROBE_MCP_APP_URI);
  }finally{
    if(before===undefined)delete process.env.FENO_PC_WIDGET_MODE;
    else process.env.FENO_PC_WIDGET_MODE=before;
    if(probeBefore===undefined)delete process.env.FENO_PC_WIDGET_PROBES;
    else process.env.FENO_PC_WIDGET_PROBES=probeBefore;
  }
});
