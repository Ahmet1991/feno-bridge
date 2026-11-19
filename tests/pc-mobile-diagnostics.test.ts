import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {registerPcTools,type PcHost} from '../src/pc-control/mcp-tools';
import {observePcRequests,createPcRequestLog} from '../src/pc-control/request-log';

test('MCP request logging correlates metadata only and rotates',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pc-log-'));
  const file=join(dir,'pc-mcp-requests.jsonl');
  const sink=createPcRequestLog(file,1024);
  const transport:any={send:async()=>{}};
  observePcRequests(transport,sink);
  transport.onmessage({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'ChatGPT',version:'1.2'},protocolVersion:'2025-06-18',capabilities:{roots:{secret:'NO_LOG'}},_meta:{'openai/userAgent':'ChatGPT iOS',token:'NO_LOG'}}});
  await transport.send({jsonrpc:'2.0',id:1,result:{secret:'NO_LOG'}});
  transport.onmessage({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'pc_capture_screen',arguments:{text:'NO_LOG'}}});
  await transport.send({jsonrpc:'2.0',id:2,result:{isError:true,structuredContent:{code:'pc_access_denied'},content:[{data:'NO_LOG'}]}});
  transport.onmessage({jsonrpc:'2.0',id:3,method:'resources/read',params:{uri:'ui://widget/test.html'}});
  await transport.send({jsonrpc:'2.0',id:3,error:{code:-32602,message:'NO_LOG'}});
  transport.onmessage({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'pc_capture_screen',arguments:{text:'NO_LOG'}}});
  await transport.send({jsonrpc:'2.0',id:4,result:{isError:true,structuredContent:{code:'pc_helper_timeout',reason:'helper_deadline'},content:[{data:'NO_LOG'}]}});
  const raw=readFileSync(file,'utf8');
  expect(raw).not.toContain('NO_LOG');
  const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
  expect(rows[0]).toMatchObject({method:'initialize',clientInfo:{name:'ChatGPT',version:'1.2'},protocolVersion:'2025-06-18',capabilityKeys:['roots'],outcome:'ok'});
  expect(rows[1]).toMatchObject({method:'tools/call',tool:'pc_capture_screen',outcome:'error',code:'pc_access_denied'});
  expect(rows[2]).toMatchObject({method:'resources/read',uri:'ui://widget/test.html',code:-32602});
  expect(rows[3]).toMatchObject({method:'tools/call',tool:'pc_capture_screen',outcome:'error',code:'pc_helper_timeout',reason:'helper_deadline'});
  expect(rows[0].responseBytes).toBeGreaterThan(0);
  for(let i=0;i<30;i++)sink({method:'tools/list',outcome:'ok',responseBytes:20});
  expect(readdirSync(dir)).toContain('pc-mcp-requests.jsonl.1');
});

test('configured probes and compatible metadata are advertised',async()=>{
  const defs=new Map<string,any>(),resources=new Map<string,any>();
  const server={server:{setRequestHandler(){}},registerTool:(n:string,d:any)=>defs.set(n,d),registerResource:(n:string,u:string,d:any,h:any)=>resources.set(u,h)} as unknown as McpServer;
  registerPcTools(server,{authorizer:new PcAuthorizer({profileId:'pc2-normal'}),host:{} as PcHost,pcWidgetProbes:true});
  expect(defs.has('pc_widget_probe_mcpapp')).toBe(true);
  expect(defs.has('pc_widget_probe_skybridge')).toBe(true);
  const uri=defs.get('pc_capture_screen')._meta.ui.resourceUri;
  const resource=(await resources.get(uri)()).contents[0];
  expect(resource._meta['openai/widgetCSP']).toEqual({connect_domains:[],resource_domains:[]});
  expect(resource._meta.ui.csp).toEqual({connectDomains:[],resourceDomains:[]});
});

test('all PC screenshot tools are unconditionally read-only and describe ChatGPT-only display',()=>{
  const defs=new Map<string,any>();
  const server={server:{setRequestHandler(){}},registerTool:(n:string,d:any)=>defs.set(n,d),registerResource:()=>{}} as unknown as McpServer;
  // Model the former normal runtime, which always passed a mirror callback even when disabled.
  const deps={authorizer:new PcAuthorizer({profileId:'pc2-normal'}),host:{} as PcHost,pcWidgetProbes:true,pcScreenshotMirrorDir:()=>undefined};
  registerPcTools(server,deps);
  for(const name of ['pc_capture_screen','pc_capture_full_screen','pc_show_image']){
    const tool=defs.get(name);
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.description??'').not.toMatch(/drive|klasör|mirror/i);
  }
  expect(defs.get('pc_show_image').description).toBe('İzinli köklerden sınırlı boyutta PNG/JPEG/WebP görüntüsü oku ve ChatGPT içinde göster.');
});
