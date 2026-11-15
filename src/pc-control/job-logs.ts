import {StringDecoder} from 'node:string_decoder';
const LINE=2048,LINES=20000,BYTES=2*1024*1024;
const SECRET_KEY=/\b[a-z0-9_.-]*(?:token|password|secret|api[_-]?key|authorization)[a-z0-9_.-]*["']?\s*$/i;
/** Redact before truncation, including quoted assignments and carriage-return progress output. */
export function redactPcText(text:string):string {
  return text.replace(/\b(Bearer)\s+(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s"']+)/gi,'$1 [REDACTED]')
    .replace(/\b([a-z0-9_.-]*(?:token|password|secret|api[_-]?key|authorization)[a-z0-9_.-]*)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s"']+)/gi,'$1=[REDACTED]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g,'[REDACTED]');
}
export function createPcJobLog(){
  const lines:string[]=[];let bytes=0,base=0;
  function append(raw:string,overflow:boolean){
    const safe=redactPcText(raw);const line=overflow?safe.slice(0,LINE-11)+'[truncated]':safe.slice(0,LINE);
    lines.push(line);bytes+=Buffer.byteLength(line);
    while(lines.length>LINES||bytes>BYTES){bytes-=Buffer.byteLength(lines.shift()!);base++;}
  }
  function stream(){
    const decoder=new StringDecoder('utf8');let pending='',overflow=false,wasCR=false,recent='';
    let hiding:'waiting'|'quoted'|'bare'|undefined,quote='',escaped=false;
    function emit(char:string){
      if(char==='\n'&&wasCR){wasCR=false;recent='';return;}
      if(char==='\n'||char==='\r'){append(pending,overflow);pending='';overflow=false;wasCR=char==='\r';recent='';return;}
      wasCR=false;if(pending.length<LINE*2)pending+=char;else overflow=true;
    }
    function text(value:string){for(const char of value){
      // Secret state is independent of the bounded output buffer, chunk boundaries
      // and line delimiters. A long quoted value cannot leak its continuation.
      if(hiding==='quoted'){
        if(char===quote&&!escaped){hiding=undefined;recent='';continue;}
        if(char==='\r'||char==='\n')emit(char);
        escaped=char==='\\'&&!escaped;continue;
      }
      if(hiding==='bare'){
        if(!/[\s"']/.test(char))continue;hiding=undefined;recent='';
      }
      if(hiding==='waiting'){
        if(/\s/.test(char)){emit(char);continue;}
        emit('[REDACTED]');recent='';
        if(char==='"'||char==="'"){hiding='quoted';quote=char;escaped=false;}else hiding='bare';continue;
      }
      if((char===':'||char==='=')&&SECRET_KEY.test(recent)){
        emit(char);hiding='waiting';recent='';continue;
      }
      if(/\s/.test(char)&&/\bBearer$/i.test(recent)){
        emit(char);hiding='waiting';recent='';continue;
      }
      emit(char);recent=(recent+char).slice(-512);
    }}
    return {write:(chunk:Buffer)=>text(decoder.write(chunk)),end(){text(decoder.end());if(pending||overflow)append(pending,overflow);pending='';overflow=false;}};
  }
  const stdout=stream(),stderr=stream();
  return {stdout,stderr,end(){stdout.end();stderr.end();},page(cursor:number){
    const start=Math.min(lines.length,Math.max(0,cursor-base)),page:string[]=[];let size=0;
    for(let i=start;i<lines.length&&page.length<250;i++){
      const line=lines[i]!;const n=Buffer.byteLength(line);if(size+n>64*1024)break;page.push(line);size+=n;
    }
    return {lines:page,nextCursor:base+start+page.length,firstCursor:base,endCursor:base+lines.length,truncated:base>0};
  }};
}
