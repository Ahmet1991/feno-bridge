const test=require('node:test'),assert=require('node:assert/strict');
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},fire(...args){for(const fn of this.listeners)fn(...args);}});
async function fixture(){
  const {createChromeEngine}=await import('../chrome-extension/engine.js');
  const tabs=new Map([[1,{id:1,url:'https://example.test/',windowId:1}],[2,{id:2,url:'https://example.test/',windowId:1}],[3,{id:3,url:'chrome://settings',windowId:1}]]);
  const calls=[],storage={};let next=3;
  const chrome={tabs:{get:async id=>{if(!tabs.has(id))throw Error();return tabs.get(id);},create:async a=>{const t={...a,id:++next,windowId:1};tabs.set(t.id,t);return t;},query:async()=>[...tabs.values()],remove:async id=>tabs.delete(id),goBack:async()=>{},goForward:async()=>{},reload:async()=>{},onUpdated:event(),onRemoved:event()},storage:{local:{get:async k=>({[k]:storage[k]}),set:async o=>Object.assign(storage,o)}},
    debugger:{onDetach:event(),onEvent:event(),attach:async()=>{},detach:async()=>calls.push('detach'),sendCommand:async(_,m,p)=>{calls.push(m);if(m==='Runtime.evaluate')return {result:{value:42}};return {};}},action:{setBadgeText:async()=>{}},scripting:{executeScript:async({args:[action]})=>[{result:action==='sensitivePage'?false:action==='guard'?{sensitive:false}:action==='read'?{documentId:'d',nodes:[]}:action==='form'?{ok:true,value:'x'}:true}]}};
  const engine=createChromeEngine(chrome,{recordIdleMs:25});return {engine,chrome,tabs,calls};
}
test('new Chrome actions guard tabs and preserve ownership across worker restart',async()=>{
  const {engine,chrome,tabs}=await fixture();const {createChromeEngine}=await import('../chrome-extension/engine.js');
  try{
    for(const action of ['close','go','form','upload','js','console','network']){await assert.rejects(engine.run(action,{tabId:3}),/pc_chrome_blocked_page/);await assert.rejects(engine.run(action,{tabId:99}),/pc_chrome_tab_not_found/);}
    await assert.rejects(engine.run('close',{tabId:1}),/pc_chrome_rejected/);
    tabs.get(1).pinned=true;await assert.rejects(engine.run('close',{tabId:1,userTab:true}),/pc_chrome_rejected/);tabs.get(1).pinned=false;
    tabs.get(1).active=true;await assert.rejects(engine.run('close',{tabId:1,userTab:true}),/pc_chrome_rejected/);tabs.get(1).active=false;
    const query=chrome.tabs.query;chrome.tabs.query=async()=>[tabs.get(1)];await assert.rejects(engine.run('close',{tabId:1,userTab:true}),/pc_chrome_rejected/);chrome.tabs.query=query;
    const {tabId}=await engine.run('open',{url:'https://example.test/'});const restarted=createChromeEngine(chrome);try{await restarted.run('close',{tabId});assert.ok(!tabs.has(tabId));}finally{await restarted.disconnect();}
    const newTab=await engine.run('open',{url:'https://example.test/'});await engine.resetOwnership();await assert.rejects(engine.run('close',{tabId:newTab.tabId}),/pc_chrome_rejected/);
    for(const action of ['back','forward','reload'])await engine.run('go',{tabId:1,action});
    chrome.tabs.goBack=async()=>{throw Error('no history');};await assert.rejects(engine.run('go',{tabId:1,action:'back'}),/pc_chrome_rejected/);
    await engine.run('read',{tabId:1});assert.equal((await engine.run('form',{tabId:1,ref:'ref_1',value:'x'})).value,'x');
    assert.equal(JSON.parse((await engine.run('js',{tabId:1,code:'42'})).json),42);
  }finally{await engine.disconnect();}
});
test('recording masks network secrets, bounds buffers, and detaches after inactivity',async()=>{
  const {engine,chrome,calls}=await fixture();const emit=(method,params)=>chrome.debugger.onEvent.fire({tabId:1},method,params);
  try{
    await engine.run('console',{tabId:1});await engine.run('network',{tabId:1});
    for(let i=0;i<501;i++)emit('Runtime.consoleAPICalled',{type:'error',args:[{value:'error '+i}]});
    assert.equal((await engine.run('console',{tabId:1,limit:500})).entries.length,500);
    emit('Network.requestWillBeSent',{requestId:'a',timestamp:1,type:'Fetch',request:{method:'GET',url:'https://example.test/?token=secret',headers:{Authorization:'secret','X-App-Token':'secret'}}});
    emit('Network.responseReceived',{requestId:'a',timestamp:2,type:'Fetch',response:{status:200,mimeType:'text/plain',headers:{'Set-Cookie':'secret'}}});
    const result=await engine.run('network',{tabId:1});assert.match(JSON.stringify(result),/REDACTED/);assert.ok(!JSON.stringify(result).includes('secret'));
    emit('Network.loadingFinished',{requestId:'a',timestamp:3,encodedDataLength:14});
    const original=chrome.debugger.sendCommand;chrome.debugger.sendCommand=async(...args)=>args[1]==='Network.getResponseBody'?{body:'fixture body',base64Encoded:false}:original(...args);
    assert.deepEqual((await engine.run('network',{tabId:1,requestId:'a',maxChars:4})).body,'fixt');
    for(let i=0;i<501;i++)emit('Network.requestWillBeSent',{requestId:String(i),timestamp:1,type:'Fetch',request:{method:'GET',url:'https://example.test/'+i,headers:{}}});
    assert.equal((await engine.run('network',{tabId:1,limit:500})).entries.length,500);
    assert.ok(!(await engine.run('network',{tabId:1,limit:500})).entries.some(e=>e.requestId==='a'));
    await engine.run('console',{tabId:1,clear:true});assert.equal((await engine.run('console',{tabId:1})).entries.length,0);
    emit('Runtime.consoleAPICalled',{type:'error',args:[{value:'old domain'}]});chrome.tabs.onUpdated.fire(1,{url:'https://new.test/'});(await chrome.tabs.get(1)).url='https://new.test/';
    assert.equal((await engine.run('console',{tabId:1})).entries.length,0);assert.equal((await engine.run('network',{tabId:1})).entries.length,0);
    await new Promise(r=>setTimeout(r,60));assert.ok(calls.includes('detach'));
  }finally{await engine.disconnect();}
});
test('form DOM enforces selection, sensitive fields, and emits both events',async()=>{
  const {pageOperation}=await import('../chrome-extension/dom.js');const previous=globalThis.__fenoPc2State;
  const events=[];const element=(fields)=>({isConnected:true,getAttribute:()=>null,dispatchEvent:e=>events.push(e.type),...fields});
  const options=[{value:'a',text:'Alpha',selected:false},{value:'b',text:'Beta',selected:false}];
  const select=element({tagName:'SELECT',options,multiple:true,get selectedOptions(){return options.filter(o=>o.selected);}});
  // Object spread evaluates getters, so define the live selectedOptions getter.
  Object.defineProperty(select,'selectedOptions',{get:()=>options.filter(o=>o.selected)});
  const checkbox=element({tagName:'INPUT',type:'checkbox',checked:false}),password=element({tagName:'INPUT',type:'password'});
  globalThis.__fenoPc2State={id:'fixture',refs:new Map([['ref_1',select],['ref_2',checkbox],['ref_3',password]])};
  const form=(ref,value)=>pageOperation('form',{ref,documentId:'fixture',value});
  try{assert.deepEqual(form('ref_1',['Alpha','b']).value,['a','b']);assert.match(form('ref_1','missing').reason,/Alpha/);assert.equal(form('ref_2',true).value,true);assert.equal(form('ref_3','secret').sensitive,true);assert.deepEqual(events,['input','change','input','change']);}
  finally{globalThis.__fenoPc2State=previous;}
});
test('label refs resolve controls in form, upload, read and find',async()=>{
  const {pageOperation}=await import('../chrome-extension/dom.js');
  const {Window}=await import('happy-dom');
  const window=new Window();const previous=globalThis.__fenoPc2State,doc=globalThis.document,EventClass=globalThis.Event;
  globalThis.document=window.document;globalThis.Event=window.Event;delete globalThis.__fenoPc2State;
  try{
    document.body.innerHTML=`<label>Nested select<select><option value="a">Alpha</option><option value="b">Beta</option></select></label><label for="s">External select</label><select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select><label>Nested check<input type="checkbox"></label><label for="c">External check</label><input id="c" type="checkbox"><label>Nested radio<input type="radio"></label><label for="r">External radio</label><input id="r" type="radio"><label>Nested date<input type="date"></label><label for="d">External date</label><input id="d" type="date"><label>Nested text<input></label><label for="t">External text</label><input id="t"><label>Secret<input type="password"></label><label>Disabled<input disabled></label><label>Readonly<input readonly></label><label>Orphan</label><label for="f">File label</label><input id="f" type="file"><label>Disabled file<input type="file" disabled></label>`;
    for(const e of document.querySelectorAll('*'))e.getClientRects=()=>[{}];
    const get=(name,mode='find')=>{const result=pageOperation(mode,{query:name,mode:'tree'});const record=result.nodes.find(n=>n.role==='label'&&n.name.includes(name));assert.ok(record,name);return {record,documentId:result.documentId};};
    const act=(action,name,args={})=>{const {record,documentId}=get(name);return pageOperation(action,{ref:record.ref,documentId,...args});};
    for(const prefix of ['Nested','External']){
      for(const [kind,value,expected] of [['select','Beta','b'],['select','a','a'],['check',true,true],['radio',true,true],['date','2026-11-18','2026-11-18'],['text','hello','hello']]){
        const name=prefix+' '+kind;assert.deepEqual(act('form',name,{value}),{ok:true,value:expected,via:'label'});
      }
    }
    assert.equal(act('form','Secret',{value:'x'}).sensitive,true);
    assert.equal(act('uploadTarget','Secret',{marker:'x'}).sensitive,true);
    for(const name of ['Disabled','Readonly'])assert.equal(act('form',name,{value:'x'}).reason,'Alan değiştirilemez.');
    assert.equal(act('form','Orphan',{value:'x'}).reason,'Bu etiket bir form alanına bağlı değil.');
    assert.deepEqual(act('uploadTarget','Orphan',{marker:'m'}),{direct:false});
    assert.deepEqual(act('uploadTarget','File label',{marker:'m'}),{direct:true,via:'label'});
    assert.equal(document.querySelector('#f').getAttribute('data-feno-upload'),'m');
    assert.equal(act('uploadTarget','Disabled file',{marker:'m'}).reason,'Alan değiştirilemez.');
    for(const mode of ['read','find']){assert.equal(get('External select',mode).record.control,'select');assert.equal(get('External check',mode).record.control,'checkbox');assert.equal(get('File label',mode).record.control,'file');assert.equal(get('Orphan',mode).record.control,undefined);}
  }finally{globalThis.__fenoPc2State=previous;globalThis.document=doc;globalThis.Event=EventClass;await window.happyDOM.close();}
});
test('upload direct and intercepted chooser use CDP and JS exceptions/timeouts recover',async()=>{
  const {engine,chrome,calls}=await fixture();let direct=true,jsMode='exception';
  chrome.scripting.executeScript=async({args:[action]})=>[{result:action==='read'?{documentId:'d',nodes:[]}:action==='uploadTarget'?{direct}:action==='ref'?{x:10,y:10,sensitive:false}:action==='guard'?{sensitive:false}:action==='sensitivePage'?false:action==='visibility'?'visible':true}];
  chrome.debugger.sendCommand=async(_,method,p)=>{calls.push([method,p]);
    if(method==='Runtime.evaluate'){if(jsMode==='hang')return new Promise(()=>{});if(jsMode==='exception')return {exceptionDetails:{lineNumber:2,text:'fixture failure'}};return {result:{value:12}};}
    if(method==='DOM.getDocument')return {root:{nodeId:1}};if(method==='DOM.querySelector')return {nodeId:2};if(method==='DOM.resolveNode')return {object:{objectId:'fixture'}};
    if(method==='Runtime.callFunctionOn')return {result:{value:[{name:'a.txt',size:3}]}};
    if(method==='Input.dispatchMouseEvent'&&p.type==='mouseReleased')chrome.debugger.onEvent.fire({tabId:1},'Page.fileChooserOpened',{backendNodeId:3});return {};
  };
  try{await engine.run('read',{tabId:1});for(const mode of [true,false]){direct=mode;assert.deepEqual((await engine.run('upload',{tabId:1,ref:'ref_1',paths:['D:\\fixture\\a.txt']})).files,[{name:'a.txt',size:3}]);}
    const methods=calls.filter(Array.isArray).map(c=>c[0]);assert.equal(methods.filter(m=>m==='DOM.setFileInputFiles').length,2);assert.ok(methods.indexOf('Page.setInterceptFileChooserDialog')<methods.indexOf('Input.dispatchMouseEvent'));
    await assert.rejects(engine.run('js',{tabId:1,code:'throw 1'}),e=>e.message==='pc_chrome_js_exception'&&e.reason.includes('Satır 3'));
    jsMode='hang';await assert.rejects(engine.run('js',{tabId:1,code:'new Promise(()=>{})',timeoutSeconds:1}),/pc_chrome_timeout/);
    jsMode='ok';assert.equal(JSON.parse((await engine.run('js',{tabId:1,code:'12'})).json),12);
  }finally{await engine.disconnect();}
});
test('a tab Chrome put to sleep reports pc_chrome_tab_sleeping and can still be reloaded',async()=>{
  const {engine,chrome,tabs}=await fixture();
  chrome.windows={getAll:async()=>[{id:1,focused:true,tabs:[...tabs.values()]}]};
  chrome.tabs.update=async(id,o)=>Object.assign(tabs.get(id),o);
  try{
    for(const state of ['discarded','frozen']){
      tabs.get(1)[state]=true;
      const listed=(await engine.run('tabs',{})).windows[0].tabs;
      assert.equal(listed.find(t=>t.tabId===1).sleeping,true);
      assert.equal('sleeping' in listed.find(t=>t.tabId===2),false);
      for(const action of ['read','find','form','js','console','network','click','type','upload'])
        await assert.rejects(engine.run(action,{tabId:1,mode:'text',ref:'ref_1',code:'1'}),/pc_chrome_tab_sleeping/);
      await assert.rejects(engine.run('computer',{tabId:1,action:'screenshot'}),/pc_chrome_tab_sleeping/);
      assert.deepEqual(await engine.run('go',{tabId:1,action:'reload'}),{ok:true,domain:'example.test'});
      assert.equal((await engine.run('navigate',{tabId:1,url:'https://example.test/next'})).ok,true);
      delete tabs.get(1)[state];
      assert.equal(typeof (await engine.run('read',{tabId:1})).nodes,'object');
    }
    // Chrome can discard the tab after the state check; the failed injection then names the cause.
    const inject=chrome.scripting.executeScript;
    chrome.scripting.executeScript=async()=>{tabs.get(1).discarded=true;throw Error('Cannot access contents of the page');};
    await assert.rejects(engine.run('read',{tabId:1}),/pc_chrome_tab_sleeping/);
    delete tabs.get(1).discarded;
    chrome.scripting.executeScript=async()=>{throw Error('Frame with ID 0 is showing error page');};
    await assert.rejects(engine.run('read',{tabId:1}),/pc_chrome_blocked_page/);
    chrome.scripting.executeScript=inject;
  }finally{await engine.disconnect();}
});
