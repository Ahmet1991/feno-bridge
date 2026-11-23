import sharp from 'sharp';
import { VERSION } from '../version';

export const PC_SCREENSHOT_URI = `ui://widget/pc-screenshot-v${VERSION}.html`;
export const PC_SCREENSHOT_MIME = 'text/html;profile=mcp-app';
export const PC_SCREENSHOT_SKYBRIDGE_URI = `ui://widget/pc-screenshot-skybridge-v${VERSION}.html`;
export const PC_SCREENSHOT_SKYBRIDGE_MIME = 'text/html+skybridge';
const MAX_EDGE = 1280;
const MAX_WIDGET_BYTES = 400_000;

export type PcScreenshotSource = {
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  title: string;
};

/** The original image remains model-visible; the smaller JPEG is widget-only. */
export async function makePcScreenshotResult({data, mimeType, title}: PcScreenshotSource) {
  const original = Buffer.from(data);
  const image = sharp(original, {limitInputPixels: 100_000_000, failOn: 'error'});
  const source = await image.metadata();
  if (!source.width || !source.height) throw new Error('Invalid screenshot dimensions');
  let preview = await image.clone().rotate().resize(MAX_EDGE, MAX_EDGE, {fit: 'inside', withoutEnlargement: true})
    .jpeg({quality: 80}).toBuffer();
  if (preview.length > MAX_WIDGET_BYTES) {
    preview = await image.clone().rotate().resize(1024, 1024, {fit: 'inside', withoutEnlargement: true})
      .jpeg({quality: 65}).toBuffer();
  }
  if (preview.length > MAX_WIDGET_BYTES) {
    preview = await image.clone().rotate().resize(800, 800, {fit: 'inside', withoutEnlargement: true})
      .jpeg({quality: 50}).toBuffer();
  }
  if (preview.length > MAX_WIDGET_BYTES) throw new Error('Screenshot preview exceeds size limit');
  const previewMeta = await sharp(preview).metadata();
  const capturedAt = new Date().toISOString();
  return {
    content: [{type: 'image' as const, mimeType, data: original.toString('base64')}],
    structuredContent: {ok: true, width: source.width, height: source.height, capturedAt, title,
      previewWidth: previewMeta.width, previewHeight: previewMeta.height},
    _meta: {pcScreenshot: {dataUrl: `data:image/jpeg;base64,${preview.toString('base64')}`}},
  };
}

/** Self-contained ChatGPT/MCP Apps card; it never fetches or loads remote resources. */
function makeScreenshotHtml() {return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feno Bridge · Ekran görüntüsü</title>
<style>
:root{color-scheme:light dark;font:14px/1.45 system-ui,-apple-system,sans-serif;--bg:#fff;--fg:#17202d;--muted:#64748b;--line:#dce3ed}
@media(prefers-color-scheme:dark){:root{--bg:#20242b;--fg:#f5f7fc;--muted:#a7b5c9;--line:#424b59}}
body{margin:0;background:var(--bg);color:var(--fg)}
[hidden]{display:none!important}
main{width:100%;min-height:64px;box-sizing:border-box;padding:12px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:0 2px 10px}
#title{font-weight:650;overflow-wrap:anywhere}#time{font-size:12px;color:var(--muted);white-space:nowrap}
button{font:inherit;color:inherit;cursor:zoom-in;border:0;background:none;padding:0}
#show{width:100%;display:block;border:1px solid var(--line);border-radius:10px;overflow:hidden}
#preview{display:block;width:100%;height:auto;max-height:480px;object-fit:contain}
#empty{padding:4px 2px;color:var(--muted)}
#diagnostic{font-size:12px;overflow-wrap:anywhere;color:var(--fg);padding:4px 2px}
#zoom{display:none;position:relative;width:100%;box-sizing:border-box;background:#12161e;padding:44px 12px 12px;border-radius:10px;overflow:hidden;cursor:zoom-out}
#zoom[aria-hidden="false"]{display:block}
#zoom img{display:block;width:100%;height:auto;max-height:none;object-fit:contain}
#close{position:absolute;top:6px;right:16px;color:white;cursor:pointer;padding:5px 9px;font-size:22px}
</style></head><body><main><header><div id="title">Feno Bridge · Ekran görüntüsü hazırlanıyor…</div><time id="time"></time></header>
<button id="show" type="button" aria-label="Ekran görüntüsünü büyüt" hidden><img id="preview" alt="Bilgisayar ekranının görüntüsü"></button>
<div id="empty">Görüntü yükleniyor…</div><div id="diagnostic" role="status" hidden></div></main>
<div id="zoom" aria-hidden="true" role="dialog" aria-label="Büyük ekran görüntüsü"><button id="close" type="button" aria-label="Kapat">×</button><img id="large" alt="Büyütülmüş ekran görüntüsü"></div>
<script>
(()=>{
const byId=id=>document.getElementById(id);
const zoom=byId('zoom');
let connected=false,hostContext={},nextId=1,lastHeight=-1,lastClassicHeight=-1,lastSizedAt=0,resizeTimer=null,lastPaint='';
let resultReceived=false,imageBytes=0,imageValid=false,diagnosticsReady=false,displayMode='inline',pendingMode=null;
const parent=window.parent;
const embedded=parent&&parent!==window;
function send(method,params){const id=nextId++;parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return id}
function notify(method,params){if(embedded)parent.postMessage({jsonrpc:'2.0',method,params},'*')}
function size(){
  const mainHeight=document.querySelector('main')?.getBoundingClientRect().height||0;
  const zoomHeight=zoom.getBoundingClientRect().height||0;
  const height=Math.max(64,Math.ceil(mainHeight+zoomHeight||document.body.scrollHeight||64));
  const classic=window.openai;
  const needsMcp=embedded&&height!==lastHeight;
  const needsClassic=typeof classic?.notifyIntrinsicHeight==='function'&&height!==lastClassicHeight;
  if(!needsMcp&&!needsClassic)return;
  const elapsed=Date.now()-lastSizedAt;
  if(lastSizedAt&&elapsed<80){
    if(resizeTimer===null)resizeTimer=setTimeout(()=>{resizeTimer=null;size()},80-elapsed);
    return;
  }
  lastSizedAt=Date.now();
  if(needsMcp){lastHeight=height;notify('ui/notifications/size-changed',{height})}
  if(needsClassic){lastClassicHeight=height;try{classic.notifyIntrinsicHeight(height)}catch{}}
}
function diagnostic(){
  const d=byId('diagnostic');d.hidden=!diagnosticsReady||imageValid;
  if(!d.hidden)d.textContent='window.openai: '+(window.openai?'var':'yok')+
    ' · MCP Apps yanıtı: '+(connected?'geldi':'gelmedi')+
    ' · Araç sonucu: '+(resultReceived?'geldi':'gelmedi')+
    ' · Görüntü verisi: '+(imageBytes?'var':'yok')+' ('+imageBytes+' bayt)';
  size();
}
function context(update){hostContext={...hostContext,...update};const root=document.documentElement;
  if(hostContext.theme==='dark'||hostContext.theme==='light'){
    root.setAttribute('data-theme',hostContext.theme);
    const dark=hostContext.theme==='dark';
    root.style.setProperty('--bg',dark?'#20242b':'#fff');root.style.setProperty('--fg',dark?'#f5f7fc':'#17202d');
    root.style.setProperty('--muted',dark?'#a7b5c9':'#64748b');root.style.setProperty('--line',dark?'#424b59':'#dce3ed');
  }
  const dims=hostContext.containerDimensions||{};
  root.style.maxWidth=Number.isFinite(dims.maxWidth)?dims.maxWidth+'px':'';
  if(update.displayMode&&update.displayMode!==displayMode)applyMode(update.displayMode);
  size();
}
function applyMode(mode){displayMode=mode;zoom.setAttribute('aria-hidden',mode==='fullscreen'?'false':'true');byId('show').hidden=mode==='fullscreen'||!imageValid;size()}
function inlineZoom(){byId('show').hidden=true;zoom.setAttribute('aria-hidden','false');size();byId('close').focus()}
function requestMode(mode,fallback){
  if(pendingMode)return;
  const finish=actual=>{if(actual===mode)applyMode(actual);else fallback()};
  if(typeof window.openai?.requestDisplayMode==='function'){
    const token={};pendingMode=token;
    const done=actual=>{if(pendingMode!==token)return;clearTimeout(token.timer);pendingMode=null;finish(actual)};
    token.timer=setTimeout(()=>done(null),1500);
    try{Promise.resolve(window.openai.requestDisplayMode({mode})).then(r=>done(r?.mode||window.openai?.displayMode),()=>done(null))}catch{done(null)}
    return;
  }
  if(connected&&hostContext.availableDisplayModes?.includes(mode)){
    const id=send('ui/request-display-mode',{mode});
    const token={id,finish};pendingMode=token;
    token.timer=setTimeout(()=>{if(pendingMode===token){pendingMode=null;fallback()}},1500);
    return;
  }
  fallback();
}
function close(){if(displayMode==='fullscreen'){requestMode('inline',()=>applyMode('inline'));return}applyMode('inline');byId('show').focus()}
byId('close').addEventListener('click',close);
zoom.addEventListener('click',e=>{if(e.target===zoom)close()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&zoom.getAttribute('aria-hidden')==='false')close()});
byId('show').addEventListener('click',()=>requestMode('fullscreen',inlineZoom));
function paint(summary,data){
  resultReceived=true;
  imageBytes=typeof data?.dataUrl==='string'?Math.floor((data.dataUrl.split(',')[1]||'').replace(/=+$/,'').length*3/4):0;
  const key=JSON.stringify([summary.title,summary.capturedAt,data?.dataUrl]);
  if(key===lastPaint)return;
  lastPaint=key;
  if(!data||typeof data.dataUrl!=='string'||!/^data:image\\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data.dataUrl)){
    imageValid=false;byId('show').hidden=true;byId('empty').hidden=false;byId('empty').textContent='Görüntü verisi bulunamadı.';diagnostic();return;
  }
  imageValid=true;
  byId('preview').src=data.dataUrl;byId('large').src=data.dataUrl;
  byId('title').textContent=typeof summary.title==='string'?summary.title:'Ekran görüntüsü';
  const when=Date.parse(summary.capturedAt||'');
  byId('time').textContent=Number.isFinite(when)?new Intl.DateTimeFormat('tr-TR',{dateStyle:'short',timeStyle:'medium'}).format(when):'';
  byId('empty').hidden=true;byId('show').hidden=zoom.getAttribute('aria-hidden')==='false';diagnostic();
}
let globals={};
function render(event){
  globals={...globals,...event?.detail?.globals};
  const host=window.openai||{};
  const envelope=globals.toolResponseMetadata||host.toolResponseMetadata||{};
  const result=envelope.mcp_tool_result||envelope.call_tool_result||{};
  const data=(result._meta?.pcScreenshot||result.result?._meta?.pcScreenshot||envelope._meta?.pcScreenshot||envelope.pcScreenshot);
  const summary=globals.toolOutput||host.toolOutput||result.structuredContent||{};
  if(data||(!imageValid&&(globals.toolOutput||host.toolOutput||globals.toolResponseMetadata||host.toolResponseMetadata)))paint(summary,data);
  const mode=globals.displayMode||host.displayMode;
  if(mode&&mode!==displayMode)applyMode(mode);
  diagnostic();
}
const initializeId=embedded?send('ui/initialize',{
  protocolVersion:'2026-01-26',appInfo:{name:'feno-pc-screenshot',title:'Feno Bridge Ekran Görüntüsü',version:'${VERSION}'},
  appCapabilities:{availableDisplayModes:['inline','fullscreen']}}):null;
window.addEventListener('message',event=>{
  if(event.source!==parent||!event.data||event.data.jsonrpc!=='2.0')return;
  const msg=event.data;
  if(pendingMode&&msg.id===pendingMode.id&&pendingMode.id!==undefined){
    const token=pendingMode;pendingMode=null;clearTimeout(token.timer);token.finish(msg.result?.mode);return;
  }
  if(msg.id===initializeId&&initializeId!==null){
    if(msg.error){byId('empty').textContent='Görüntü kartı bağlantısı açılamadı.';return}
    if(!msg.result||typeof msg.result!=='object')return;
    connected=true;notify('ui/notifications/initialized',{});
    // Early size notifications may have been ignored before initialization.
    lastHeight=-1;
    context(msg.result.hostContext||{});diagnostic();
    return;
  }
  if(msg.method==='ui/notifications/host-context-changed'){context(msg.params||{});return}
  if(msg.method==='ui/notifications/tool-input'){byId('empty').textContent='Ekran görüntüsü alınıyor…';return}
  if(msg.method==='ui/notifications/tool-result'){
    const result=msg.params||{};paint(result.structuredContent||{},result._meta?.pcScreenshot);return;
  }
  if(msg.method==='ui/notifications/tool-cancelled'){
    imageValid=false;byId('show').hidden=true;byId('empty').hidden=false;byId('empty').textContent='Ekran görüntüsü iptal edildi.';diagnostic();return;
  }
  if(msg.method==='ui/resource-teardown'&&msg.id!==undefined){parent.postMessage({jsonrpc:'2.0',id:msg.id,result:{}},'*')}
});
byId('preview').addEventListener('load',size);
byId('large').addEventListener('load',size);
byId('preview').addEventListener('error',()=>{imageValid=false;byId('show').hidden=true;byId('empty').hidden=false;byId('empty').textContent='Görüntü açılamadı.';diagnostic()});
window.addEventListener('openai:set_globals',render);
if(typeof window.ResizeObserver==='function')new window.ResizeObserver(size).observe(document.body);
setTimeout(()=>{diagnosticsReady=true;diagnostic()},5000);
render();
})();
</script></body></html>`;}

export const PC_SCREENSHOT_HTML=makeScreenshotHtml();
export const PC_SCREENSHOT_SKYBRIDGE_HTML=PC_SCREENSHOT_HTML;
