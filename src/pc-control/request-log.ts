import {appendFileSync,existsSync,renameSync,lstatSync} from 'node:fs';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';

type Row=Record<string,unknown>;
const short=(value:unknown,max=100)=>typeof value==='string'?value.slice(0,max).replace(/[\x00-\x1f\x7f]/g,''):undefined;
const identifier=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_.:/-]{1,128}$/.test(value)?value:'unknown';
export function createPcRequestLog(file:string,maxBytes=2*1024*1024){
  return (row:Row)=>{
    try{
      const line=JSON.stringify(row)+'\n';
      if(existsSync(file)){
        const stat=lstatSync(file);
        if(!stat.isFile()||stat.isSymbolicLink())return;
        if(stat.size+Buffer.byteLength(line)>maxBytes)renameSync(file,file+'.1');
      }
      appendFileSync(file,line,{encoding:'utf8',mode:0o600});
    }catch{/* Diagnostics must never affect a request. */}
  };
}

/** Observe the actual wire, without retaining arguments, response content or request IDs. */
export function observePcRequests(transport:Transport,write:(row:Row)=>void):Transport{
  const pending=new Map<string|number,Row>();
  const emit=(row:Row)=>{try{write(row);}catch{}};
  const receive=transport.onmessage;
  transport.onmessage=(message,extra)=>{
    if('method' in message){
      const params=message.params??{};
      const row:Row={at:new Date().toISOString(),method:identifier(message.method)};
      if(message.method==='tools/call')row.tool=identifier(params.name);
      if(message.method==='resources/read'){
        const uri=params.uri;
        row.uri=typeof uri==='string'&&/^ui:\/\/[a-zA-Z0-9._/-]{1,512}$/.test(uri)?uri:'redacted';
      }
      if(message.method==='initialize'){
        const info=params.clientInfo as Record<string,unknown>|undefined;
        row.clientInfo={name:short(info?.name),version:short(info?.version)};
        row.protocolVersion=short(params.protocolVersion);
        row.capabilityKeys=Object.keys((params.capabilities as object)??{}).slice(0,32).map(identifier);
      }
      const meta=params._meta;
      if(meta&&typeof meta==='object'){
        const hints:Row={};
        for(const [key,value] of Object.entries(meta)){
          if(/^(?:openai\/)?(?:userAgent|clientName|clientVersion|platform|deviceType|os|appVersion)$/i.test(key)){
            hints[key]=short(value,160);
          }
        }
        if(Object.keys(hints).length)row.clientHints=hints;
      }
      if('id' in message){
        if(pending.size>=1024||pending.has(message.id))emit({...row,outcome:'error',code:'tracking_limit',responseBytes:0});
        else pending.set(message.id,row);
      }else emit({...row,outcome:'ok',responseBytes:0});
    }
    receive?.(message,extra);
  };
  const send=transport.send.bind(transport);
  transport.send=async(message,options)=>{
    const id='id' in message&& !('method' in message)?message.id:undefined;
    const row=id==null?undefined:pending.get(id);
    if(row&&id!=null)pending.delete(id);
    try{
      await send(message,options);
      if(row)try{
        const result='result' in message?message.result:undefined;
        const failed='error' in message||result?.isError===true;
        const content=result?.structuredContent as Record<string,unknown>|undefined;
        const code='error' in message?message.error.code:failed?identifier(content?.code):undefined;
        const reason=typeof code==='string'&&['pc_desktop_unavailable','pc_helper_timeout','pc_helper_failed','pc_grant_changed'].includes(code)?short(content?.reason,160):undefined;
        emit({...row,outcome:failed?'error':'ok',...(failed?{code}:{}),...(reason?{reason}:{}),responseBytes:Buffer.byteLength(JSON.stringify(message))});
      }catch{/* Measuring the response must not turn an already sent reply into an error. */}
    }catch(error){if(row)emit({...row,outcome:'error',code:'transport_send',responseBytes:0});throw error;}
  };
  const close=transport.onclose;
  transport.onclose=()=>{for(const row of pending.values())emit({...row,outcome:'error',code:'transport_closed',responseBytes:0});pending.clear();close?.();};
  return transport;
}
