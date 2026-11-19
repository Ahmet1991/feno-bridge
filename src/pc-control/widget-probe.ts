/** Minimal, dependency-free cards to identify which ChatGPT iframe bridge is working. */
export const PC_PROBE_MCP_APP_URI = 'ui://widget/probe-mcpapp-v5.1.27.html';
export const PC_PROBE_SKYBRIDGE_URI = 'ui://widget/probe-skybridge-v5.1.27.html';

function makeProbeHtml(mode:'mcpapp'|'skybridge') {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feno Bridge · Bağlantı teşhisi</title>
<style>:root{color-scheme:light dark;font:14px/1.55 system-ui,sans-serif}body{margin:0;padding:14px;background:Canvas;color:CanvasText}
main{border:1px solid #9996;border-radius:10px;padding:12px}h1{font-size:16px;margin:0 0 7px}p{margin:0 0 8px}#status{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace;background:Canvas;border:1px solid #8886;padding:9px;border-radius:7px}</style>
</head><body><main><h1>Feno Bridge · ${mode==='mcpapp'?'MCP Apps':'Skybridge'} teşhis kartı</h1>
<p id="probe-text">Türkçe test kartı</p><div id="status" role="status" aria-live="polite"></div></main>
<script>
(()=>{
const isMcp=${mode==='mcpapp'};
const status=document.getElementById('status');
let lastStatus='';
function line(message){if(String(message)===lastStatus)return;lastStatus=String(message);status.textContent+=(status.textContent?'\\n':'')+String(message)}
window.onerror=function(message){line('hata: '+String(message));return false};
window.addEventListener('unhandledrejection',event=>line('hata: '+String(event.reason)));
line('yüklendi');line('window.openai '+(window.openai?'var':'yok'));
let connection=false;let nextId=1;let initId=null;let version='2026-01-26';let lastResult='';let lastHeight=-1,lastSizedAt=0,resizeTimer=null;
const parent=window.parent;
function notify(method,params){parent.postMessage({jsonrpc:'2.0',method,params},'*')}
function send(method,params){const id=nextId++;parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return id}
function initialize(protocolVersion){return send('ui/initialize',{protocolVersion,appInfo:{name:'feno-pc-probe',version:'5.1.27'},
  appCapabilities:{availableDisplayModes:['inline']}})}
function toolResult(result){if(result&&typeof result==='object'){
  const key=JSON.stringify(result);if(key===lastResult)return;lastResult=key;line('araç sonucu geldi');
}else line('hata: araç sonucu boş')}
function size(){if(!connection)return;const height=Math.max(1,Math.ceil(document.body.scrollHeight||130));
  if(height===lastHeight)return;
  const elapsed=Date.now()-lastSizedAt;
  if(lastHeight>=0&&elapsed<80){
    if(resizeTimer===null)resizeTimer=setTimeout(()=>{resizeTimer=null;size()},80-elapsed);
    return;
  }
  lastHeight=height;lastSizedAt=Date.now();notify('ui/notifications/size-changed',{height})}
function skyResult(){const host=window.openai||{};if(host.toolOutput||host.toolResponseMetadata)toolResult(host.toolOutput||host.toolResponseMetadata)}
window.addEventListener('openai:set_globals',skyResult);
if(isMcp){
  window.addEventListener('message',event=>{
    if(event.source!==parent||!event.data||event.data.jsonrpc!=='2.0')return;
    const msg=event.data;
    if(msg.id===initId&&initId!==null){
      if(msg.error){
        const offered=msg.error.data?.supportedVersions;
        const accepted=Array.isArray(offered)?offered.find(item=>typeof item==='string'&&/^\\d{4}-\\d{2}-\\d{2}$/.test(item)&&item!==version):null;
        if(accepted){version=accepted;initId=initialize(version);line('el sıkışma yeniden gönderildi: '+version);return}
        line('hata: '+(msg.error.message||JSON.stringify(msg.error)));return;
      }
      if(!msg.result){line('hata: boş el sıkışma yanıtı');return}
      line('yanıt geldi: '+String(msg.result.protocolVersion||'sürüm bildirilmedi'));
      connection=true;
      const context=msg.result.hostContext||{};
      if(context.theme)document.documentElement.setAttribute('data-theme',context.theme);
      notify('ui/notifications/initialized',{});
      size();
      return;
    }
    if(msg.method==='ui/notifications/tool-input')line('araç girdisi geldi');
    if(msg.method==='ui/notifications/tool-result')toolResult(msg.params);
    if(msg.method==='ui/notifications/host-context-changed'&&msg.params?.theme)document.documentElement.setAttribute('data-theme',msg.params.theme);
  });
  if(typeof ResizeObserver==='function')new ResizeObserver(()=>{
    size();
  }).observe(document.body);
  if(parent&&parent!==window){
    initId=initialize(version);
    line('el sıkışma gönderildi');
  }else line('hata: üst pencere bulunamadı');
}else skyResult();
})();
</script></body></html>`;
}

export const PC_PROBE_MCP_APP_HTML = makeProbeHtml('mcpapp');
export const PC_PROBE_SKYBRIDGE_HTML = makeProbeHtml('skybridge');
