import {expect, test} from 'bun:test';
import {Window} from 'happy-dom';
import {PC_SCREENSHOT_HTML} from '../src/pc-control/screenshot-widget';

function frame() {
  const win=new Window({settings:{disableJavaScriptEvaluation:false}});
  const sent:any[]=[];
  const parent={postMessage:(message:unknown)=>sent.push(message)};
  Object.defineProperty(win,'parent',{value:parent,configurable:true});
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
  expect(sent.some(m=>m.method==='ui/notifications/initialized')).toBe(false);
  emit({jsonrpc:'2.0',id:sent[0].id,result:{protocolVersion:'2026-01-26',hostCapabilities:{},hostInfo:{name:'test-host',version:'1'},hostContext:{theme:'dark',containerDimensions:{maxHeight:700,maxWidth:520}}}});
  expect(sent[1]?.method).toBe('ui/notifications/initialized');
  expect(win.document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(sent.some(m=>m.method==='ui/notifications/size-changed')).toBe(true);
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
