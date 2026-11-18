"use strict";
const http = require('node:http'), crypto = require('node:crypto'), path = require('node:path'), fs=require('node:fs');
const MAX_BODY=32*1024*1024, TTL=8000;
const error=code=>({ok:false,code});
const hostName='com.feno.bridge.pc2';
const extensionId='mcimkhafgpcecjdjjiljhljdkaggapfa';
const descriptorName='chrome-native-descriptor.json';
function chromeDirectory(env=process.env) {
  if(!env.LOCALAPPDATA||!path.isAbsolute(env.LOCALAPPDATA))throw Error('pc_chrome_not_connected');
  return path.join(env.LOCALAPPDATA,'Feno Bridge Chrome PC2');
}
function createChromeBroker({version,directory,files,isAuthorized,audit=()=>{},clock=Date.now}) {
  const token=crypto.randomBytes(32).toString('hex'), descriptor=path.join(directory,descriptorName);
  let enabled=false, defaultPending=false, client, pending, reloadVersion, closed=false;
  const saved=path.join(directory,'enabled.json');
  const validClient=()=>client&&clock()-client.seen<TTL&&client.version===version;
  function finish(result) {
    if(!pending)return;
    const p=pending;pending=undefined;clearTimeout(p.timer);p.resolve(result);
  }
  function permitted(){try{return isAuthorized()===true;}catch{return false;}}
  function gate(){if(!permitted())return 'pc_access_denied';if(!enabled)return 'pc_chrome_disabled';if(!validClient())return 'pc_chrome_not_connected';}
  function revoke(code){finish(error(code));}
  function setEnabled(value){if(typeof value!=='boolean')throw Error('pc_invalid_argument');defaultPending=false;enabled=value;if(!value)revoke('pc_chrome_disabled');return status();}
  function status(){return {enabled,connected:!!validClient(),version:client&&clock()-client.seen<TTL?client.version:null};}
  async function read(req){
    const chunks=[];let n=0;
    for await(const chunk of req){n+=chunk.length;if(n>MAX_BODY)throw Error('too_large');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function authenticated(req){
    const provided=Buffer.from(req.headers.authorization||'');const expected=Buffer.from('Bearer '+token);
    return provided.length===expected.length&&crypto.timingSafeEqual(provided,expected);
  }
  function reply(res,data,status=200){if(!res.destroyed&&!res.headersSent){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));}}
  const server=http.createServer(async(req,res)=>{
    if(closed||req.method!=='POST'||!authenticated(req)||req.headers.origin||req.headers.host!==('127.0.0.1:'+server.address()?.port)){reply(res,error('pc_access_denied'),403);return;}
    try {
      const b=await read(req);
      if(req.url==='/poll'){
        if(typeof b.session!=='string'||!/^[a-f0-9-]{36}$/.test(b.session)||typeof b.version!=='string'||!/^\d+\.\d+\.\d+$/.test(b.version)){reply(res,error('pc_invalid_argument'),400);return;}
        if(client&&clock()-client.seen<TTL&&client.session!==b.session){reply(res,{type:'idle'});return;}
        if(client?.session!==b.session){revoke('pc_chrome_not_connected');client={session:b.session,version:b.version,seen:clock()};}
        client.seen=clock();client.version=b.version;
        if(b.version!==version){
          if(reloadVersion?.version!==b.version||clock()-reloadVersion.at>=30000){reloadVersion={version:b.version,at:clock()};reply(res,{type:'reload',version});}
          else reply(res,{type:'idle'});
          return;
        }
        reloadVersion=undefined;
        if(defaultPending&&permitted()){
          files.writePrivateAtomic(saved,Buffer.from(JSON.stringify({enabled:true})));setEnabled(true);
        }
        const code=gate();if(code){revoke(code);reply(res,{type:'idle'});return;}
        if(pending&&!pending.sent){pending.sent=true;reply(res,{type:'command',id:pending.id,action:pending.action,args:pending.args});}
        else reply(res,{type:'idle'});
        return;
      }
      if(req.url==='/heartbeat'){
        if(client?.session===b.session)client.seen=clock();
        if(client?.session===b.session&&pending?.id===b.id&&pending.sent&&enabled&&permitted()){
          client.seen=clock();reply(res,{type:'continue'});return;
        }
        reply(res,{type:'cancel'});return;
      }
      if(req.url==='/result'){
        if(client?.session===b.session&&pending?.id===b.id&&pending.sent){
          const code=gate();if(code)revoke(code);
          else if(b.ok===true&&b.data&&typeof b.data==='object')finish({ok:true,data:b.data});
          else finish(error(typeof b.code==='string'&&/^pc_(chrome_[a-z_]+|invalid_argument)$/.test(b.code)?b.code:'pc_chrome_operation_failed'));
        }
        reply(res,{ok:true});return;
      }
      if(req.url==='/disconnect'){
        if(client?.session===b.session){client=undefined;revoke('pc_chrome_not_connected');}
        reply(res,{ok:true});return;
      }
      if(req.url==='/command'){
        const code=gate();if(code){reply(res,error(code));return;}
        if(pending){reply(res,error('pc_chrome_busy'));return;}
        if(!['tabs','open','navigate','read','find','computer','click','type'].includes(b.action)||!b.args||typeof b.args!=='object'||Array.isArray(b.args)){
          reply(res,error('pc_invalid_argument'));return;
        }
        const timeout=Math.min(60,Math.max(1,Number(b.args.timeoutSeconds)||30))*1000;
        const result=await new Promise(resolve=>{
          const id=crypto.randomUUID();
          pending={id,action:b.action,args:b.args,resolve,sent:false,timer:setTimeout(()=>finish(error('pc_chrome_timeout')),timeout)};
          res.on('close',()=>{if(pending?.id===id)finish(error('pc_chrome_timeout'));});
        });
        const domain=typeof result.data?.domain==='string'&&/^[a-z0-9.:[\]-]{1,253}$/i.test(result.data.domain)?result.data.domain:undefined;
        try{audit({tool:'pc_chrome_'+b.action,outcome:result.ok?'ok':'error',...(domain?{domain}:{})});}catch{}
        reply(res,result);return;
      }
      reply(res,error('pc_invalid_argument'),404);
      }catch{reply(res,error('pc_invalid_argument'),400);}
  });
  server.requestTimeout=70000;server.headersTimeout=10000;server.maxHeadersCount=20;
  const watchdog=setInterval(()=>{const code=gate();if(code)revoke(code);},500);watchdog.unref?.();
  return {
    status,setEnabled,
    async start(){
      files.ensurePrivateDirectory(directory);
      try{enabled=JSON.parse(files.readPrivateFile(saved,1024).toString('utf8')).enabled===true;}catch{enabled=false;try{fs.lstatSync(saved);}catch(e){defaultPending=e.code==='ENOENT';}}
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      if(closed){server.close();throw Error('pc_chrome_not_connected');}
      try{files.writePrivateAtomic(descriptor,Buffer.from(JSON.stringify({port:server.address().port,token})));}catch(e){server.close();throw e;}
    },
    toggle(value){if(typeof value!=='boolean')throw Error('pc_invalid_argument');if(!value)setEnabled(false);files.writePrivateAtomic(path.join(directory,'enabled.json'),Buffer.from(JSON.stringify({enabled:value})));return setEnabled(value);},
    close(){closed=true;clearInterval(watchdog);revoke('pc_chrome_not_connected');server.close();server.closeAllConnections?.();try{if(JSON.parse(files.readPrivateFile(descriptor,4096).toString('utf8')).token===token)files.removePrivateFile(descriptor);}catch{}}
  };
}
module.exports={createChromeBroker,chromeDirectory,descriptorName,hostName,extensionId};
