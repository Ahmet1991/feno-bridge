import {expect, test} from 'bun:test';
import {Window,type HTMLButtonElement,type HTMLElement} from 'happy-dom';
import {PC_SCREENSHOT_HTML} from '../src/pc-control/screenshot-widget';

function frame(openai?:object) {
  const win=new Window({settings:{disableJavaScriptEvaluation:false}});
  const sent:any[]=[];
  const parent={postMessage:(message:unknown)=>sent.push(message)};
  Object.defineProperty(win,'parent',{value:parent,configurable:true});
  if(openai)Object.defineProperty(win,'openai',{value:openai,configurable:true});
  const script=PC_SCREENSHOT_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if(!script)throw new Error('Missing inline widget script');
  win.document.write(PC_SCREENSHOT_HTML.replace(/<script>[\s\S]*?<\/script>/,''));
  win.eval(script);
  const emit=(data:unknown)=>win.dispatchEvent(new win.MessageEvent('message',{data,source:parent as any}));
  return {win,sent,emit};
}

test('MCP Apps handshake precedes initialized and uses the negotiated context',()=>{
  const {win,sent,emit}=frame();
  expect(sent[0]?.method).toBe('ui/initialize');
  expect(sent[0]?.params?.appInfo?.name).toBeTruthy();
  expect(sent[0]?.params?.appCapabilities?.availableDisplayModes).toContain('inline');
  expect(sent[0]?.params?.appCapabilities?.availableDisplayModes).toEqual(['inline','fullscreen']);
  expect(sent.some(m=>m.method==='ui/notifications/initialized')).toBe(false);
  emit({jsonrpc:'2.0',id:sent[0].id,result:{protocolVersion:'2026-01-26',hostCapabilities:{},hostInfo:{name:'test-host',version:'1'},hostContext:{theme:'dark',containerDimensions:{maxHeight:700,maxWidth:520}}}});
  expect(sent.some(m=>m.method==='ui/notifications/initialized')).toBe(true);
  expect(win.document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(sent.some(m=>m.method==='ui/notifications/size-changed')).toBe(true);
  win.happyDOM.abort();
});

test('classic host paints without handshake, reports size and requests fullscreen only on tap',async()=>{
  const heights:number[]=[];const modes:string[]=[];
  const globals={toolOutput:{title:'Telefon'},toolResponseMetadata:{pcScreenshot:{dataUrl:'data:image/jpeg;base64,YWJj'}},
    notifyIntrinsicHeight:(h:number)=>heights.push(h),requestDisplayMode:async({mode}:{mode:string})=>{modes.push(mode);return {mode:'inline'}}};
  const {win,sent}=frame(globals);
  expect(win.document.getElementById('title')?.textContent).toBe('Telefon');
  expect(heights[0]).toBeGreaterThanOrEqual(64);
  expect(modes).toEqual([]);
  const before=heights.length;
  for(let i=0;i<50;i++)win.dispatchEvent(new win.Event('openai:set_globals'));
  expect(heights).toHaveLength(before);
  expect(sent.some(m=>m.method==='ui/notifications/size-changed')).toBe(true);
  (win.document.getElementById('show') as HTMLButtonElement).click();
  await Bun.sleep(20);
  expect(modes).toEqual(['fullscreen']);
  expect(win.document.getElementById('zoom')?.getAttribute('aria-hidden')).toBe('false');
  win.happyDOM.abort();
});

test('no bridge response: visible initial status, diagnostics after five seconds and inline zoom',async()=>{
  const {win,sent,emit}=frame();
  expect(win.document.getElementById('title')?.textContent).toContain('Feno Bridge');
  expect(sent.some(m=>m.method==='ui/notifications/size-changed'&&m.params.height>=64)).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,5100));
  expect(win.document.getElementById('diagnostic')?.textContent).toContain('window.openai: yok');
  expect(win.document.getElementById('diagnostic')?.textContent).toContain('gelmedi');
  emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{title:'Görüntü'},_meta:{pcScreenshot:{dataUrl:'data:image/jpeg;base64,YWJj'}}}});
  expect((win.document.getElementById('diagnostic') as HTMLElement|null)?.hidden).toBe(true);
  (win.document.getElementById('show') as HTMLButtonElement).click();
  expect(win.document.getElementById('zoom')?.getAttribute('aria-hidden')).toBe('false');
  win.happyDOM.abort();
},10000);

test('negotiated MCP fullscreen request follows tap and falls back on rejection',()=>{
  const {win,sent,emit}=frame();
  emit({jsonrpc:'2.0',id:sent[0].id,result:{hostContext:{availableDisplayModes:['inline','fullscreen']}}});
  emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{title:'Not Defteri'},_meta:{pcScreenshot:{dataUrl:'data:image/jpeg;base64,YWJj'}}}});
  expect(sent.some(m=>m.method==='ui/request-display-mode')).toBe(false);
  (win.document.getElementById('show') as HTMLButtonElement).click();
  const request=sent.find(m=>m.method==='ui/request-display-mode');
  expect(request?.params.mode).toBe('fullscreen');
  emit({jsonrpc:'2.0',id:request.id,error:{code:-1,message:'not supported'}});
  expect(win.document.getElementById('zoom')?.getAttribute('aria-hidden')).toBe('false');
  win.happyDOM.abort();
});

test('screenshot stays inline and stable over 50 identical tool results and host updates',()=>{
  const {win,sent,emit}=frame();
  expect(PC_SCREENSHOT_HTML).toMatch(/max-height:\s*480px/);
  emit({jsonrpc:'2.0',id:sent[0].id,result:{protocolVersion:'2026-01-26',hostContext:{theme:'light',containerDimensions:{maxWidth:520}}}});
  const result={jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{title:'Not Defteri'},_meta:{pcScreenshot:{dataUrl:'data:image/jpeg;base64,YWJj'}}}};
  emit(result);
  const before=sent.filter(m=>m.method==='ui/notifications/size-changed').length;
  const image=win.document.getElementById('preview');
  for(let i=0;i<50;i++){
    emit(result);
    emit({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'light',containerDimensions:{maxWidth:520}}});
  }
  expect(image?.getAttribute('src')).toBe('data:image/jpeg;base64,YWJj');
  expect(sent.filter(m=>m.method==='ui/notifications/size-changed')).toHaveLength(before);
  expect(sent.some(m=>m.method==='ui/request-display-mode')).toBe(false);
  (win.document.getElementById('show') as HTMLButtonElement|null)?.click();
  expect(sent.some(m=>m.method==='ui/request-display-mode')).toBe(false);
  win.happyDOM.abort();
});

test('rapid image-height changes are rate limited before notifying the host',()=>{
  const {win,sent,emit}=frame();
  let height=200;
  Object.defineProperty(win.document.body,'scrollHeight',{configurable:true,get:()=>height});
  emit({jsonrpc:'2.0',id:sent[0].id,result:{protocolVersion:'2026-01-26',hostContext:{}}});
  const count=()=>sent.filter(m=>m.method==='ui/notifications/size-changed').length;
  const initial=count();
  for(let i=0;i<50;i++){
    height=201+i;
    win.document.getElementById('preview')?.dispatchEvent(new win.Event('load'));
  }
  expect(count()).toBeLessThanOrEqual(initial+1);
  win.happyDOM.abort();
});

test('MCP tool result paints private JPEG and reports missing metadata without network requests',()=>{
  const {win,sent,emit}=frame();
  const network:string[]=[];
  Object.defineProperty(win,'fetch',{value:()=>{network.push('fetch');throw Error('network');}});
  Object.defineProperty(win,'XMLHttpRequest',{value:class{constructor(){network.push('xhr');}}});
  emit({jsonrpc:'2.0',id:sent[0].id,result:{protocolVersion:'2026-01-26',hostCapabilities:{},hostInfo:{name:'test',version:'1'},hostContext:{}}});
  emit({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{windowId:'123'}}});
  emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{title:'Not Defteri',capturedAt:'2026-11-16T17:00:00Z'},_meta:{pcScreenshot:{dataUrl:'data:image/jpeg;base64,YWJj'}}}});
  expect(win.document.getElementById('preview')?.getAttribute('src')).toBe('data:image/jpeg;base64,YWJj');
  expect(win.document.getElementById('title')?.textContent).toBe('Not Defteri');
  emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{title:'Eksik'},content:[]}});
  expect(win.document.getElementById('empty')?.textContent).toContain('bulunamadı');
  expect(network).toEqual([]);
  win.happyDOM.abort();
});
