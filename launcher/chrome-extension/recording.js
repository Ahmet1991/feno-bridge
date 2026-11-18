const secretParam=/^(token|access_token|id_token|key|api_key|code|password|secret|sig|signature|session)$/i;
const secretHeader=/^(authorization|cookie|set-cookie|proxy-authorization|x-.*-token)$/i;
export function maskUrl(raw){
  try{const u=new URL(raw);u.username='';u.password='';for(const key of [...u.searchParams.keys()])if(secretParam.test(key))u.searchParams.set(key,'REDACTED');
    if(u.hash.includes('='))u.hash='';return u.href.slice(0,4096);
  }catch{return '';}
}
function headers(value){return Object.fromEntries(Object.entries(value||{}).slice(0,32).map(([k,v])=>[k.slice(0,128),secretHeader.test(k)?'REDACTED':String(v).replace(/https?:\/\/[^\s,;]+/g,maskUrl).replace(/([?&](?:token|access_token|id_token|key|api_key|code|password|secret|sig|signature|session)=)[^&#\s;]*/gi,'$1REDACTED').slice(0,256)]));}
const text=v=>String(v??'').slice(0,2000);
const consoleAdd=(r,e)=>{r.entries.push(e);if(r.entries.length>500)r.entries.shift();};
const netAdd=(r,id,e)=>{r.requests.delete(id);r.requests.set(id,e);if(r.requests.size>500)r.requests.delete(r.requests.keys().next().value);};
export function createRecord(domain){return {domain,entries:[],requests:new Map()};}
export function recordEvent(r,method,p){
  if(method==='Runtime.consoleAPICalled')consoleAdd(r,{level:p.type,text:text((p.args||[]).map(a=>a.value===undefined?a.description:typeof a.value==='object'?JSON.stringify(a.value):a.value).join(' ')),timestamp:p.timestamp});
  else if(method==='Runtime.exceptionThrown'){const e=p.exceptionDetails;consoleAdd(r,{level:'error',text:text(e?.exception?.description||e?.text),line:(e?.lineNumber??0)+1,timestamp:p.timestamp});}
  else if(method==='Log.entryAdded'){const e=p.entry;if(e)consoleAdd(r,{level:e.level,text:text(e.text),url:maskUrl(e.url),timestamp:e.timestamp});}
  else if(method==='Network.requestWillBeSent')netAdd(r,p.requestId,{requestId:p.requestId,method:p.request.method,url:maskUrl(p.request.url),type:p.type,start:p.timestamp,requestHeaders:headers(p.request.headers),status:null,size:0,duration:null});
  else if(method.startsWith('Network.')){
    const e=r.requests.get(p.requestId);if(!e)return;
    if(method==='Network.responseReceived'){Object.assign(e,{status:p.response.status,type:p.type,mimeType:p.response.mimeType,responseHeaders:headers(p.response.headers)});}
    else if(method==='Network.requestWillBeSentExtraInfo')e.requestHeaders={...e.requestHeaders,...headers(p.headers)};
    else if(method==='Network.responseReceivedExtraInfo')e.responseHeaders={...e.responseHeaders,...headers(p.headers)};
    else if(method==='Network.loadingFinished'){e.size=p.encodedDataLength;e.duration=Math.max(0,Math.round((p.timestamp-e.start)*1000));e.finished=true;}
    else if(method==='Network.loadingFailed'){e.duration=Math.max(0,Math.round((p.timestamp-e.start)*1000));e.error=text(p.errorText);consoleAdd(r,{level:'error',text:e.error,url:e.url});}
  }
}
export const textualMime=m=>/^(text\/|application\/(?:[\w.+-]*\+)?(?:json|xml|javascript|x-www-form-urlencoded)(?:;|$))/i.test(m||'');
export function boundedJson(value,max=20000){const serialized=JSON.stringify(value??null);return {json:serialized.slice(0,max),truncated:serialized.length>max};}
export function consoleEntries(r,a){const pattern=String(a.pattern||'').toLowerCase();return r.entries.filter(e=>(!a.onlyErrors||['error','assert'].includes(e.level))&&JSON.stringify(e).toLowerCase().includes(pattern)).slice(-(a.limit||100));}
export function networkEntries(r,a){const pattern=String(a.urlPattern||'').toLowerCase();return [...r.requests.values()].filter(e=>e.url.toLowerCase().includes(pattern)).slice(-(a.limit||100)).map(({start,finished,...e})=>e);}
