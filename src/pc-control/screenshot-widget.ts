import sharp from 'sharp';

export const PC_SCREENSHOT_URI = 'ui://widget/pc-screenshot-v5.1.11.html';
export const PC_SCREENSHOT_MIME = 'text/html;profile=mcp-app';
export const PC_SCREENSHOT_SKYBRIDGE_URI = 'ui://widget/pc-screenshot-skybridge-v5.1.11.html';
export const PC_SCREENSHOT_SKYBRIDGE_MIME = 'text/html+skybridge';
const MAX_EDGE = 1600;
const MAX_WIDGET_BYTES = 1_800_000;

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
    preview = await image.clone().rotate().resize(1200, 1200, {fit: 'inside', withoutEnlargement: true})
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
function makeScreenshotHtml(mode:'mcpapp'|'skybridge') {return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feno Bridge · Ekran görüntüsü</title>
<style>
:root{color-scheme:light dark;font:14px/1.45 system-ui,-apple-system,sans-serif;--bg:#fff;--fg:#17202d;--muted:#64748b;--line:#dce3ed}
@media(prefers-color-scheme:dark){:root{--bg:#20242b;--fg:#f5f7fc;--muted:#a7b5c9;--line:#424b59}}
body{margin:0;background:var(--bg);color:var(--fg)}
[hidden]{display:none!important}
main{width:100%;box-sizing:border-box;padding:12px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:0 2px 10px}
#title{font-weight:650;overflow-wrap:anywhere}#time{font-size:12px;color:var(--muted);white-space:nowrap}
button{font:inherit;color:inherit;cursor:zoom-in;border:0;background:none;padding:0}
#show{width:100%;display:block;border:1px solid var(--line);border-radius:10px;overflow:hidden}
#preview{display:block;width:100%;height:auto;max-height:480px;object-fit:contain}
#empty{padding:24px;text-align:center;color:var(--muted)}
#zoom{display:none;position:relative;width:100%;box-sizing:border-box;background:#12161e;padding:44px 12px 12px;border-radius:10px;overflow:hidden;cursor:zoom-out}
#zoom[aria-hidden="false"]{display:block}
#zoom img{display:block;width:100%;height:auto;max-height:none;object-fit:contain}
#close{position:absolute;top:6px;right:16px;color:white;cursor:pointer;padding:5px 9px;font-size:22px}
</style></head><body><main><header><div id="title">Ekran görüntüsü</div><time id="time"></time></header>
<button id="show" type="button" aria-label="Ekran görüntüsünü büyüt" hidden><img id="preview" alt="Bilgisayar ekranının görüntüsü"></button>
<div id="empty">Görüntü yükleniyor…</div></main>
<div id="zoom" aria-hidden="true" role="dialog" aria-label="Büyük ekran görüntüsü"><button id="close" type="button" aria-label="Kapat">×</button><img id="large" alt="Büyütülmüş ekran görüntüsü"></div>
<script>
(()=>{
const useMcpApp=${mode==='mcpapp'};
const byId=id=>document.getElementById(id);
const zoom=byId('zoom');
let connected=false,hostContext={},nextId=1,lastHeight=-1,lastSizedAt=0,resizeTimer=null,lastPaint='';
const parent=window.parent;
function send(method,params){const id=nextId++;parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return id}
function notify(method,params){parent.postMessage({jsonrpc:'2.0',method,params},'*')}
function size(){if(!connected)return;
  const height=Math.max(1,Math.ceil(document.body.scrollHeight||document.documentElement.scrollHeight||100));
  if(height===lastHeight)return;
  const elapsed=Date.now()-lastSizedAt;
  if(lastHeight>=0&&elapsed<80){
    if(resizeTimer===null)resizeTimer=setTimeout(()=>{resizeTimer=null;size()},80-elapsed);
    return;
  }
  lastHeight=height;
  lastSizedAt=Date.now();
  notify('ui/notifications/size-changed',{height})}
function context(update){hostContext={...hostContext,...update};const root=document.documentElement;
  if(hostContext.theme==='dark'||hostContext.theme==='light'){
    root.setAttribute('data-theme',hostContext.theme);
    const dark=hostContext.theme==='dark';
    root.style.setProperty('--bg',dark?'#20242b':'#fff');root.style.setProperty('--fg',dark?'#f5f7fc':'#17202d');
    root.style.setProperty('--muted',dark?'#a7b5c9':'#64748b');root.style.setProperty('--line',dark?'#424b59':'#dce3ed');
  }
  const dims=hostContext.containerDimensions||{};
  root.style.maxWidth=Number.isFinite(dims.maxWidth)?dims.maxWidth+'px':'';
}
function close(){zoom.setAttribute('aria-hidden','true');byId('show').hidden=false;size();byId('show').focus()}
byId('close').addEventListener('click',close);
zoom.addEventListener('click',e=>{if(e.target===zoom)close()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&zoom.getAttribute('aria-hidden')==='false')close()});
byId('show').addEventListener('click',()=>{byId('show').hidden=true;zoom.setAttribute('aria-hidden','false');size();byId('close').focus()});
function paint(summary,data){
  const key=JSON.stringify([summary.title,summary.capturedAt,data?.dataUrl]);
  if(key===lastPaint)return;
  lastPaint=key;
  if(!data||typeof data.dataUrl!=='string'||!/^data:image\\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data.dataUrl)){
    byId('show').hidden=true;byId('empty').hidden=false;byId('empty').textContent='Görüntü verisi bulunamadı.';size();return;
  }
  byId('preview').src=data.dataUrl;byId('large').src=data.dataUrl;
  byId('title').textContent=typeof summary.title==='string'?summary.title:'Ekran görüntüsü';
  const when=Date.parse(summary.capturedAt||'');
  byId('time').textContent=Number.isFinite(when)?new Intl.DateTimeFormat('tr-TR',{dateStyle:'short',timeStyle:'medium'}).format(when):'';
  byId('empty').hidden=true;byId('show').hidden=false;size();
}
function render(){
  const host=window.openai||{};
  const envelope=host.toolResponseMetadata||{};
  const result=envelope.mcp_tool_result||envelope.call_tool_result||{};
  const data=(result._meta?.pcScreenshot||result.result?._meta?.pcScreenshot||envelope._meta?.pcScreenshot||envelope.pcScreenshot);
  const summary=host.toolOutput||result.structuredContent||{};
  if(data)paint(summary,data);
}
const initializeId=useMcpApp&&parent&&parent!==window?send('ui/initialize',{
  protocolVersion:'2026-01-26',appInfo:{name:'feno-pc-screenshot',title:'Feno Bridge Ekran Görüntüsü',version:'5.1.11'},
  appCapabilities:{availableDisplayModes:['inline']}}):null;
window.addEventListener('message',event=>{
  if(event.source!==parent||!event.data||event.data.jsonrpc!=='2.0')return;
  const msg=event.data;
  if(msg.id===initializeId&&initializeId!==null){
    if(msg.error){byId('empty').textContent='Görüntü kartı bağlantısı açılamadı.';return}
    if(!msg.result||typeof msg.result!=='object')return;
    context(msg.result.hostContext||{});connected=true;
    notify('ui/notifications/initialized',{});size();
    if(typeof window.ResizeObserver==='function')new window.ResizeObserver(size).observe(document.body);
    return;
  }
  if(msg.method==='ui/notifications/host-context-changed'){context(msg.params||{});return}
  if(msg.method==='ui/notifications/tool-input'){byId('empty').textContent='Ekran görüntüsü alınıyor…';return}
  if(msg.method==='ui/notifications/tool-result'){
    const result=msg.params||{};paint(result.structuredContent||{},result._meta?.pcScreenshot);return;
  }
  if(msg.method==='ui/notifications/tool-cancelled'){
    byId('show').hidden=true;byId('empty').hidden=false;byId('empty').textContent='Ekran görüntüsü iptal edildi.';size();return;
  }
  if(msg.method==='ui/resource-teardown'&&msg.id!==undefined){parent.postMessage({jsonrpc:'2.0',id:msg.id,result:{}},'*')}
});
byId('preview').addEventListener('load',size);
window.addEventListener('openai:set_globals',render);
render();
})();
</script></body></html>`;}

export const PC_SCREENSHOT_HTML=makeScreenshotHtml('mcpapp');
export const PC_SCREENSHOT_SKYBRIDGE_HTML=makeScreenshotHtml('skybridge');
