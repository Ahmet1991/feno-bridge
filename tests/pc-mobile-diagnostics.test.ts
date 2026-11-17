import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {registerPcTools,type PcHost} from '../src/pc-control/mcp-tools';
import {observePcRequests,createPcRequestLog} from '../src/pc-control/request-log';
import {mirrorPcScreenshot} from '../src/pc-control/screenshot-mirror';

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
  const raw=readFileSync(file,'utf8');
  expect(raw).not.toContain('NO_LOG');
  const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
  expect(rows[0]).toMatchObject({method:'initialize',clientInfo:{name:'ChatGPT',version:'1.2'},protocolVersion:'2025-06-18',capabilityKeys:['roots'],outcome:'ok'});
  expect(rows[1]).toMatchObject({method:'tools/call',tool:'pc_capture_screen',outcome:'error',code:'pc_access_denied'});
  expect(rows[2]).toMatchObject({method:'resources/read',uri:'ui://widget/test.html',code:-32602});
  expect(rows[0].responseBytes).toBeGreaterThan(0);
  for(let i=0;i<30;i++)sink({method:'tools/list',outcome:'ok',responseBytes:20});
  expect(readdirSync(dir)).toContain('pc-mcp-requests.jsonl.1');
});

test('configured probes and compatible metadata are advertised',async()=>{
  const defs=new Map<string,any>(),resources=new Map<string,any>();
  const server={registerTool:(n:string,d:any)=>defs.set(n,d),registerResource:(n:string,u:string,d:any,h:any)=>resources.set(u,h)} as unknown as McpServer;
  registerPcTools(server,{authorizer:new PcAuthorizer({profileId:'pc2-normal'}),host:{} as PcHost,pcWidgetProbes:true});
  expect(defs.has('pc_widget_probe_mcpapp')).toBe(true);
  expect(defs.has('pc_widget_probe_skybridge')).toBe(true);
  const uri=defs.get('pc_capture_screen')._meta.ui.resourceUri;
  const resource=(await resources.get(uri)()).contents[0];
  expect(resource._meta['openai/widgetCSP']).toEqual({connect_domains:[],resource_domains:[]});
  expect(resource._meta.ui.csp).toEqual({connectDomains:[],resourceDomains:[]});
});

test('mirror is opt-in, confined to granted directories, PNG, and capped at 50',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-mirror-')),dir=join(root,'mirror');mkdirSync(dir);
  const auth=new PcAuthorizer({profileId:'pc2-normal'});
  auth.setGrantFromLocalApproval({profileId:'pc2-normal',id:'mirror-test',expiresAt:null,roots:[root],permissions:['files.write'],allowedApps:[]});
  const source={data:await sharp({create:{width:2,height:2,channels:3,background:'red'}}).jpeg().toBuffer(),mimeType:'image/jpeg' as const,title:'Türkçe:<başlık>'};
  expect(await mirrorPcScreenshot(undefined,source,auth)).toEqual({});
  expect(readdirSync(dir)).toEqual([]);
  for(let i=0;i<50;i++)writeFileSync(join(dir,'PC2-20200101-000000-'+i+'.png'),'old');
  writeFileSync(join(dir,'other.png'),'keep');
  const result=await mirrorPcScreenshot(dir,source,auth);
  expect(result.mirrorPath).toBeTruthy();
  expect(await sharp(result.mirrorPath!).metadata()).toMatchObject({format:'png'});
  expect(readdirSync(dir).filter(n=>n.startsWith('PC2-'))).toHaveLength(50);
  expect(readdirSync(dir)).toContain('other.png');
  expect(await mirrorPcScreenshot(tmpdir(),source,auth)).toMatchObject({mirrorError:'pc_access_denied'});
  expect(await mirrorPcScreenshot(join(dir,'absent'),source,auth)).toHaveProperty('mirrorError');
});
