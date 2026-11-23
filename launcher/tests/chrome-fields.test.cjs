const test=require('node:test'),assert=require('node:assert/strict');

test('password/payment inputs can be filled without returning their values',async()=>{
  const {pageOperation}=await import('../chrome-extension/dom.js');
  const {Window}=await import('happy-dom');
  const window=new Window(),previous={document:globalThis.document,Event:globalThis.Event,state:globalThis.__fenoPc2State};
  globalThis.document=window.document;globalThis.Event=window.Event;delete globalThis.__fenoPc2State;
  try{
    document.body.innerHTML='<label>Password<input type="password" autocomplete="current-password"></label><label>Card<input autocomplete="cc-number"></label><label>Code<input autocomplete="cc-csc"></label><label>Expiry<input autocomplete="cc-exp"></label><label>Given name<input autocomplete="cc-given-name"></label><label>Middle name<input autocomplete="cc-additional-name"></label><label>Family name<input autocomplete="cc-family-name"></label><label>Card type<input autocomplete="cc-type"></label><label>Readonly<input type="password" readonly></label>';
    for(const e of document.querySelectorAll('*'))e.getClientRects=()=>[{}];
    for(const name of ['Password','Card','Code','Expiry','Given name','Middle name','Family name','Card type']){
      const found=pageOperation('find',{query:name}),ref=found.nodes.find(n=>n.role==='label'&&n.name===name).ref;
      const result=pageOperation('form',{ref,documentId:found.documentId,value:'synthetic-secret'});
      assert.deepEqual(result,{ok:true,value:'[REDACTED]',via:'label'});
      assert.equal([...document.querySelectorAll('label')].find(e=>e.textContent===name).control.value,'synthetic-secret');
      assert.equal(pageOperation('form',{ref,documentId:'stale',value:'x'}),null);
    }
    const found=pageOperation('find',{query:'Readonly'}),ref=found.nodes.find(n=>n.role==='label').ref;
    assert.equal(pageOperation('form',{ref,documentId:found.documentId,value:'x'}).reason,'Alan değiştirilemez.');
  }finally{globalThis.document=previous.document;globalThis.Event=previous.Event;globalThis.__fenoPc2State=previous.state;await window.happyDOM.close();}
});

test('field input and JS diagnostics run on sensitive pages while frame boundaries remain',async()=>{
  const {createChromeEngine}=await import('../chrome-extension/engine.js');
  const event=()=>({addListener(){}}),calls=[];let blocked=false;
  const chrome={tabs:{get:async()=>({url:'https://example.test/login'}),onUpdated:event(),onRemoved:event()},
    debugger:{onDetach:event(),onEvent:event(),attach:async()=>{},detach:async()=>{},sendCommand:async(_,method,params)=>{calls.push({method,params});return method==='Runtime.evaluate'?{result:{value:42}}:{};}},action:{setBadgeText:async()=>{}},
    scripting:{executeScript:async({args:[action]})=>[{result:action==='read'?{documentId:'d',nodes:[]}:action==='ref'?{x:10,y:10,sensitive:true}:action==='guard'?(blocked?{blocked:true}:{sensitive:true}):action==='sensitivePage'?true:action==='visibility'?'visible':true}]}};
  const engine=createChromeEngine(chrome);
  try{
    await engine.run('read',{tabId:1});
    assert.equal((await engine.run('type',{tabId:1,ref:'ref_1',text:'fixture'})).ok,true);
    assert.equal((await engine.run('computer',{tabId:1,action:'type',text:'fixture'})).ok,true);
    assert.equal((await engine.run('computer',{tabId:1,action:'key',key:'Enter'})).ok,true);
    assert.equal(JSON.parse((await engine.run('js',{tabId:1,code:'6*7'})).json),42);
    assert.equal(calls.filter(c=>c.method==='Input.insertText').length,2);
    blocked=true;
    for(const action of ['type','js'])await assert.rejects(engine.run(action,{tabId:1,ref:'ref_1',text:'x',code:'1'}),/pc_chrome_blocked_page/);
    assert.equal(calls.filter(c=>c.method==='Input.insertText').length,2);
  }finally{await engine.disconnect();}
});

test('form masking survives page handlers changing the field type',async()=>{
  const {pageOperation}=await import('../chrome-extension/dom.js'),{Window}=await import('happy-dom');
  const window=new Window(),previous={document:globalThis.document,Event:globalThis.Event,state:globalThis.__fenoPc2State};
  globalThis.document=window.document;globalThis.Event=window.Event;
  try{
    document.body.innerHTML='<input type="password" autocomplete="current-password">';
    const field=document.querySelector('input');
    field.addEventListener('input',()=>{field.type='text';field.removeAttribute('autocomplete');});
    globalThis.__fenoPc2State={id:'d',refs:new Map([['ref_1',field]])};
    const result=pageOperation('form',{ref:'ref_1',documentId:'d',value:'synthetic-secret'});
    assert.equal(field.type,'text');assert.equal(field.value,'synthetic-secret');
    assert.deepEqual(result,{ok:true,value:'[REDACTED]'});
  }finally{globalThis.document=previous.document;globalThis.Event=previous.Event;globalThis.__fenoPc2State=previous.state;await window.happyDOM.close();}
});

test('sensitive select errors and checkbox activation do not disclose values',async()=>{
  const {pageOperation}=await import('../chrome-extension/dom.js'),{Window}=await import('happy-dom');
  const window=new Window(),previous={document:globalThis.document,Event:globalThis.Event,state:globalThis.__fenoPc2State};
  globalThis.document=window.document;globalThis.Event=window.Event;
  try{
    document.body.innerHTML='<select autocomplete="cc-number"><option value="saved-secret">Saved private card</option></select><input type="checkbox" autocomplete="cc-name">';
    const select=document.querySelector('select'),checkbox=document.querySelector('input');
    globalThis.__fenoPc2State={id:'d',refs:new Map([['ref_1',select],['ref_2',checkbox]])};
    const error=pageOperation('form',{ref:'ref_1',documentId:'d',value:'missing'});
    assert.equal(error.ok,false);assert.ok(!JSON.stringify(error).includes('saved-secret'));assert.ok(!JSON.stringify(error).includes('Saved private card'));
    const result=pageOperation('form',{ref:'ref_2',documentId:'d',value:true});
    assert.equal(checkbox.checked,true);assert.deepEqual(result,{ok:true,value:'[REDACTED]'});
  }finally{globalThis.document=previous.document;globalThis.Event=previous.Event;globalThis.__fenoPc2State=previous.state;await window.happyDOM.close();}
});
