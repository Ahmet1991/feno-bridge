import {expect,test} from 'bun:test';
import sharp from 'sharp';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {readPcImage} from '../src/pc-control/files';
import {registerPcTools,type PcHost} from '../src/pc-control/mcp-tools';
import {makePcScreenshotResult,PC_SCREENSHOT_HTML,PC_SCREENSHOT_MIME,PC_SCREENSHOT_URI} from '../src/pc-control/screenshot-widget';

const image = async () => sharp({create:{width:3200,height:1800,channels:3,background:'#6789ab'}}).png().toBuffer();

test('image tool preserves model PNG and returns bounded hidden JPEG for widget',async()=>{
  const original=await image();
  const output=await makePcScreenshotResult({data:original,mimeType:'image/png',title:'Chrome — Haberler'});
  expect(output.content[0].mimeType).toBe('image/png');
  expect(Buffer.from(output.content[0].data,'base64').equals(original)).toBe(true);
  expect(output.structuredContent).toMatchObject({ok:true,width:3200,height:1800,title:'Chrome — Haberler'});
  expect(JSON.stringify(output.structuredContent)).not.toContain('data:image');
  const url=output._meta.pcScreenshot.dataUrl;
  expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
  const preview=Buffer.from(url.slice('data:image/jpeg;base64,'.length),'base64');
  const dimensions=await sharp(preview).metadata();
  expect(Math.max(dimensions.width!,dimensions.height!)).toBeLessThanOrEqual(1600);
  expect(preview.length).toBeLessThanOrEqual(1_800_000);
});

test('widget renders the canonical host metadata envelope without external access',async()=>{
  const url=(await makePcScreenshotResult({data:await image(),mimeType:'image/png',title:'Tarayıcı'}))._meta.pcScreenshot.dataUrl;
  const nodes=new Map<string,any>();
  const handlers=new Map<string,()=>void>();const requestedModes:string[]=[];
  const getElementById=(id:string)=>{
    if(!nodes.has(id))nodes.set(id,{hidden:true,src:'',textContent:'',setAttribute:()=>{},
      addEventListener:(event:string,callback:()=>void)=>handlers.set(`${id}:${event}`,callback),focus:()=>{}});
    return nodes.get(id);
  };
  const script=PC_SCREENSHOT_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  runInNewContext(script!,{
    window:{openai:{toolOutput:{title:'Chrome • Haberler',capturedAt:'2026-11-16T16:00:00Z'},
      toolResponseMetadata:{status:'success',mcp_tool_result:{_meta:{pcScreenshot:{dataUrl:url}}}},
      requestDisplayMode:({mode}:{mode:string})=>requestedModes.push(mode)},addEventListener:()=>{}},
    document:{getElementById,addEventListener:()=>{}},
  });
  expect(getElementById('preview').src).toBe(url);
  expect(getElementById('large').src).toBe(url);
  expect(getElementById('title').textContent).toBe('Chrome • Haberler');
  expect(getElementById('show').hidden).toBe(false);
  expect(getElementById('empty').hidden).toBe(true);
  handlers.get('show:click')?.();handlers.get('close:click')?.();
  expect(requestedModes).toEqual(['fullscreen','inline']);
});

test('all screenshot tools share a discoverable self-contained resource and keep image-only metadata private',async()=>{
  const auth=new PcAuthorizer({profileId:'pc2-normal'});
  auth.setGrantFromLocalApproval({profileId:'pc2-normal',id:'image-test',expiresAt:null,fullAccess:true,
    roots:['C:\\','D:\\'],allowedApps:[],permissions:['files.read','files.write','jobs','terminal.exec','screen.read','screen.full',
      'desktop.input','desktop.advanced','apps.launch','adb','runner']});
  const png=await image();
  const definitions=new Map<string,any>();
  const callbacks=new Map<string,(args:any)=>Promise<any>>();
  let resource:()=>Promise<any>=async()=>({});
  const server={registerTool:(name:string,definition:unknown,handler:(args:any)=>Promise<any>)=>{
    definitions.set(name,definition);callbacks.set(name,handler);
  },registerResource:(_name:string,_uri:string,_opts:unknown,handler:()=>Promise<any>)=>{resource=handler;}} as unknown as McpServer;
  const host={listWindows:async()=>[{id:'123',title:'Chrome Haberler',processName:'chrome.exe'}],
    captureScreen:async()=>({mimeType:'image/png',data:png}),captureFullScreen:async()=>({mimeType:'image/png',data:png}),
    adbScreencap:async()=>png,showImage:async()=>({mimeType:'image/png',data:png})} as unknown as PcHost;
  registerPcTools(server,{authorizer:auth,host});
  const contents=(await resource()).contents[0];
  expect(contents.uri).toBe(PC_SCREENSHOT_URI);
  expect(contents.mimeType).toBe(PC_SCREENSHOT_MIME);
  expect(contents.text).toBe(PC_SCREENSHOT_HTML);
  expect(contents.text).toContain('toolResponseMetadata');
  expect(contents.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=|fetch\s*\(|XMLHttpRequest|https?:\/\//);
  expect(contents._meta.ui.csp).toEqual({connectDomains:[],resourceDomains:[]});
  expect(contents._meta['openai/ui'].availableDisplayModes).toEqual(['inline','fullscreen']);
  for(const [name,args] of [
    ['pc_capture_screen',{windowId:'123'}],['pc_capture_full_screen',{mode:'all'}],
    ['pc_adb_screencap',{serial:'emulator-5554'}],['pc_show_image',{path:'C:\\image.png'}],
  ] as const){
    const definition=definitions.get(name);
    expect(definition._meta['openai/outputTemplate']).toBe(PC_SCREENSHOT_URI);
    expect(definition._meta.ui.resourceUri).toBe(PC_SCREENSHOT_URI);
    expect(definition._meta['openai/toolInvocation/invoking']).toContain('görüntüsü');
    const response=await callbacks.get(name)!(args);
    expect(response.isError).not.toBe(true);
    expect(response.content[0].type).toBe('image');
    expect(response._meta.pcScreenshot.dataUrl).toStartWith('data:image/jpeg;base64,');
    expect(JSON.stringify(response.structuredContent)).not.toContain('base64');
  }
  expect((await callbacks.get('pc_capture_screen')!({windowId:'123'})).structuredContent.title).toBe('Chrome Haberler');
});

const windowsTest=process.platform==='win32'?test:test.skip;
windowsTest('saved image tool enforces native root, extension, signature and size checks',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-image-'));
  const auth=new PcAuthorizer({profileId:'pc2-normal'});
  auth.setGrantFromLocalApproval({profileId:'pc2-normal',id:'file-image-test',expiresAt:null,fullAccess:true,
    roots:[root.slice(0,3)],allowedApps:[],permissions:['files.read','files.write','jobs','terminal.exec','screen.read','screen.full',
      'desktop.input','desktop.advanced','apps.launch','adb','runner']});
  const valid=join(root,'capture.png');writeFileSync(valid,await image());
  expect((await readPcImage(valid,auth)).mimeType).toBe('image/png');
  const wrong=join(root,'wrong.png');writeFileSync(wrong,Buffer.from('not an image'));
  await expect(readPcImage(wrong,auth)).rejects.toThrow();
  const tooBig=join(root,'large.png');writeFileSync(tooBig,Buffer.alloc(8*1024*1024+1));
  await expect(readPcImage(tooBig,auth)).rejects.toThrow();
  await expect(readPcImage(join(root,'capture.txt'),auth)).rejects.toThrow();
});
