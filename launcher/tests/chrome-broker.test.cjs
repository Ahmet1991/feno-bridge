const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createChromeBroker,descriptorName,extensionId,hostName}=require('../electron/chrome-broker.cjs');
test('manifest locks the native origin and uses only HTTP(S) hosts',()=>{
  const m=require('../chrome-extension/manifest.json');
  const hash=crypto.createHash('sha256').update(Buffer.from(m.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  assert.equal(hash,extensionId);assert.equal(m.manifest_version,3);assert.equal(m.externally_connectable,undefined);
  assert.deepEqual(m.host_permissions,['http://*/*','https://*/*']);assert.equal(m.incognito,'not_allowed');
  const installer=fs.readFileSync(path.join(__dirname,'../installer.nsh'),'utf8');
  assert.ok(installer.includes('WriteRegStr HKCU "Software\\Google\\Chrome\\NativeMessagingHosts\\'+hostName+'"'));
  assert.ok(installer.includes('DeleteRegKey HKCU "Software\\Google\\Chrome\\NativeMessagingHosts\\'+hostName+'"'));
});
test('native port protocol enforces authorization, session ownership, cancellation and minimal audit',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'chrome-broker-test-'));
  const files={ensurePrivateDirectory(){},readPrivateFile:p=>fs.readFileSync(p),writePrivateAtomic:(p,b)=>fs.writeFileSync(p,b),removePrivateFile:p=>fs.unlinkSync(p)};
  let authorized=true,now=1000;const logs=[];
  const b=createChromeBroker({version:'5.1.19',directory,files,isAuthorized:()=>authorized,audit:r=>logs.push(r),clock:()=>now});
  try{
    await b.start();
    const {port,token}=JSON.parse(fs.readFileSync(path.join(directory,descriptorName),'utf8'));
    const post=async(endpoint,body,bearer=token)=>(await fetch('http://127.0.0.1:'+port+endpoint,{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify(body)})).json();
    const session=crypto.randomUUID(),version='5.1.19',poll=()=>post('/poll',{session,version});
    assert.equal((await post('/command',{action:'tabs',args:{}},'invalid')).code,'pc_access_denied');
    assert.equal((await post('/command',{action:'tabs',args:{}})).code,'pc_chrome_disabled');
    authorized=false;await poll();assert.equal(b.status().enabled,false);
    assert.equal((await post('/command',{action:'tabs',args:{}})).code,'pc_access_denied');
    authorized=true;await poll();assert.equal(b.status().connected,true);assert.equal(b.status().enabled,true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'enabled.json'),'utf8')).enabled,true);
    const pending=post('/command',{action:'type',args:{text:'private-fixture'}});
    let command;for(let i=0;i<20;i++){command=await poll();if(command.type==='command')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(command.action,'type');
    now+=5000;assert.equal((await post('/heartbeat',{session,id:command.id})).type,'continue');
    now+=5000;assert.equal((await post('/heartbeat',{session,id:command.id})).type,'continue');
    await post('/result',{session:crypto.randomUUID(),id:command.id,ok:true,data:{domain:'wrong.example'}});
    await post('/result',{session,id:command.id,ok:true,data:{domain:'fixture.example',text:'private-fixture'}});
    assert.equal((await pending).data.domain,'fixture.example');assert.deepEqual(logs,[{tool:'pc_chrome_type',outcome:'ok',domain:'fixture.example'}]);
    const timed=post('/command',{action:'tabs',args:{timeoutSeconds:1}});
    for(let i=0;i<20;i++){command=await poll();if(command.type==='command')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal((await timed).code,'pc_chrome_timeout');
    assert.equal((await post('/heartbeat',{session,id:command.id})).type,'cancel');
    assert.equal(b.status().connected,true);
    const next=post('/command',{action:'tabs',args:{}});
    for(let i=0;i<20;i++){command=await poll();if(command.type==='command')break;await new Promise(r=>setTimeout(r,10));}
    await post('/result',{session,id:command.id,ok:true,data:{windows:[]}});assert.equal((await next).ok,true);
    authorized=false;assert.equal((await post('/command',{action:'tabs',args:{}})).code,'pc_access_denied');
    authorized=true;const canceled=post('/command',{action:'tabs',args:{}});
    for(let i=0;i<20;i++){command=await poll();if(command.type==='command')break;await new Promise(r=>setTimeout(r,10));}
    b.toggle(false);assert.equal((await canceled).code,'pc_chrome_disabled');assert.equal((await post('/heartbeat',{session,id:command.id})).type,'cancel');
    await poll();assert.equal(b.status().enabled,false);
    b.close();
    const again=createChromeBroker({version,directory,files,isAuthorized:()=>true});
    try{await again.start();const fresh=JSON.parse(fs.readFileSync(path.join(directory,descriptorName),'utf8'));await fetch('http://127.0.0.1:'+fresh.port+'/poll',{method:'POST',headers:{authorization:'Bearer '+fresh.token},body:JSON.stringify({session,version})});assert.equal(again.status().enabled,false);}finally{again.close();}
  }finally{b.close();}
});
test('compiled native executable handles framed messages and creates a restricted manifest without registry changes',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const cp=require('node:child_process');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feno-native-host-test-'));
  const exe=path.join(root,'resources','runtime','runtime','chrome-native-host.exe');
  fs.mkdirSync(path.dirname(exe),{recursive:true});
  const compiler=['Framework64','Framework'].map(f=>path.join(process.env.SystemRoot,'Microsoft.NET',f,'v4.0.30319','csc.exe')).find(fs.existsSync);
  assert.ok(compiler);
  const compile=cp.spawnSync(compiler,['/nologo','/target:exe','/define:FENO_CHROME_TEST','/reference:System.Web.Extensions.dll','/out:'+exe,path.join(__dirname,'../electron/chrome-native-host.cs')],{encoding:'utf8',windowsHide:true});
  assert.equal(compile.status,0,compile.stdout+compile.stderr);
  assert.equal(cp.spawnSync(exe,['--manifest'],{windowsHide:true}).status,0);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'resources','chrome-native-host.json'),'utf8'));
  assert.deepEqual(manifest,{name:hostName,description:'Feno Bridge PC2 native host',path:exe,type:'stdio',allowed_origins:['chrome-extension://'+extensionId+'/']});
  assert.equal(cp.spawnSync(exe,['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],{windowsHide:true}).status,1);
  const files={ensurePrivateDirectory(){},readPrivateFile:p=>fs.readFileSync(p),writePrivateAtomic:(p,b)=>fs.writeFileSync(p,b),removePrivateFile:p=>fs.unlinkSync(p)};
  const broker=createChromeBroker({version:'5.1.19',directory:root,files,isAuthorized:()=>true});
  let host;
  try{
    await broker.start();broker.toggle(true);
    const descriptor=path.join(root,descriptorName);
    const {port,token}=JSON.parse(fs.readFileSync(descriptor,'utf8'));
    host=cp.spawn(exe,['chrome-extension://'+extensionId+'/'],{windowsHide:true,env:{...process.env,FENO_CHROME_TEST_DESCRIPTOR:descriptor},stdio:['pipe','pipe','pipe']});
    const send=m=>{const body=Buffer.from(JSON.stringify(m)),len=Buffer.alloc(4);len.writeUInt32LE(body.length);host.stdin.write(Buffer.concat([len,body]));};
    let chunks=Buffer.alloc(0),canceledId;
    host.stdout.on('data',part=>{chunks=Buffer.concat([chunks,part]);while(chunks.length>=4&&chunks.length>=4+chunks.readUInt32LE(0)){const len=chunks.readUInt32LE(0),msg=JSON.parse(chunks.subarray(4,4+len));chunks=chunks.subarray(4+len);if(msg.type==='cancel'){canceledId=msg.id;send({type:'result',id:msg.id,ok:false,code:'pc_chrome_timeout'});}else if(msg.type==='command'&&msg.args.timeoutSeconds!==1)send({type:'result',id:msg.id,ok:true,data:{domain:'fixture.example',response:'framed'}});}});
    send({type:'hello',version:'5.1.19'});
    for(let i=0;!broker.status().connected&&i<100;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(broker.status().connected,true);
    const timeout=await fetch('http://127.0.0.1:'+port+'/command',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({action:'tabs',args:{timeoutSeconds:1}})}).then(r=>r.json());
    assert.equal(timeout.code,'pc_chrome_timeout');
    const result=await fetch('http://127.0.0.1:'+port+'/command',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({action:'tabs',args:{timeoutSeconds:5}})}).then(r=>r.json());
    assert.deepEqual(result,{ok:true,data:{domain:'fixture.example',response:'framed'}});
    assert.ok(canceledId);assert.equal(host.exitCode,null);assert.equal(broker.status().connected,true);
  }finally{if(host){host.stdin.end();await new Promise(resolve=>{if(host.exitCode!==null)resolve();else{host.once('exit',resolve);setTimeout(()=>host.kill(),1500).unref();}});}broker.close();}
});
