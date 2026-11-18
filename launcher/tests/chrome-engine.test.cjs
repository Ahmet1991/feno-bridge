const test=require('node:test'),assert=require('node:assert/strict');
const event=()=>({addListener(){}});
test('Chrome engine reuses debugger, scrolls via DOM, normalizes keys, and recovers from canceled CDP',async()=>{
  const {createChromeEngine}=await import('../chrome-extension/engine.js');
  const calls=[];let scrollY=0,attach=0,detach=0,hang=false;
  const png=Buffer.alloc(24);png.writeUInt32BE(200,16);png.writeUInt32BE(160,20);
  const chrome={tabs:{get:async()=>({url:'https://fixture.test/'}),onUpdated:event(),onRemoved:event()},
    debugger:{onDetach:event(),attach:async()=>{attach++;},detach:async()=>{detach++;},sendCommand:async(_,method,params)=>{
      calls.push({method,params});if(hang)return new Promise(()=>{});return method==='Page.captureScreenshot'?{data:png.toString('base64')}:{};}},
    action:{setBadgeText:async()=>{}},scripting:{executeScript:async({args:[action,args]})=>{
      calls.push({action,args});let result=true;
      if(action==='viewport')result={id:'fixture',width:200,height:160,pageX:0,pageY:scrollY,scale:1,dpr:1};
      if(action==='guard')result={sensitive:false};
      if(action==='scroll'){scrollY+=args.delta;result={pageY:scrollY,scrollY};}
      return [{result}];}}};
  const engine=createChromeEngine(chrome,{idleMs:100});
  const run=(action,args={},signal)=>engine.run('computer',{tabId:1,action,...args},signal);
  try{
    await assert.rejects(run('click',{x:10,y:10}),/pc_chrome_screenshot_required/);assert.equal(attach,0);
    await assert.rejects(run('scroll',{x:10,y:10}),/pc_chrome_screenshot_required/);
    await run('screenshot');await run('click',{x:10,y:10});await run('hover',{x:10,y:10});
    await run('key',{key:'Enter'});await run('key',{key:'escape'});
    assert.deepEqual(calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.params.key),['Enter','Enter','Escape','Escape']);
    const scroll=await run('scroll',{x:10,y:10,delta:100});assert.equal(scroll.scrollY,100);
    assert.ok(calls.some(c=>c.action==='cursor'&&c.args.x===10));assert.ok(!calls.some(c=>c.params?.type==='mouseWheel'));
    assert.equal(attach,1);assert.equal(detach,0);await assert.rejects(run('click',{x:10,y:10}),/pc_chrome_ref_stale/);
    await run('screenshot');hang=true;const controller=new AbortController();
    const pending=run('key',{key:'enter'},controller.signal);setTimeout(()=>controller.abort(),10);
    await assert.rejects(pending,/pc_chrome_timeout/);assert.equal(detach,1);hang=false;
    await run('screenshot');assert.equal(attach,2);await new Promise(r=>setTimeout(r,150));assert.equal(detach,2);
  }finally{await engine.disconnect();}
});
test('DOM scroll chooses the nearest scrollable ancestor, then document root',async()=>{
  const {pageOperation}=await import('../chrome-extension/dom.js');
  const saved={document:globalThis.document,window:globalThis.window,getComputedStyle:globalThis.getComputedStyle,state:globalThis.__fenoPc2State};
  const make=(parentElement,scrollHeight,overflowY)=>({parentElement,scrollHeight,clientHeight:100,scrollWidth:100,clientWidth:100,overflowY,overflowX:'visible',scrollLeft:0,scrollTop:0,scrollBy({top,left}){this.scrollTop+=top;this.scrollLeft+=left;}});
  const root=make(null,1000,'visible'),container=make(root,500,'auto'),child=make(container,100,'visible');let hit=child;
  globalThis.document={scrollingElement:root,elementFromPoint:()=>hit};globalThis.window={get scrollY(){return root.scrollTop},scrollX:0};globalThis.getComputedStyle=e=>e;
  try{assert.equal(pageOperation('scroll',{point:{x:1,y:1},delta:50,deltaX:0}).scrollY,50);assert.equal(root.scrollTop,0);hit=root;assert.equal(pageOperation('scroll',{point:{x:1,y:1},delta:100,deltaX:0}).pageY,100);}
  finally{globalThis.document=saved.document;globalThis.window=saved.window;globalThis.getComputedStyle=saved.getComputedStyle;globalThis.__fenoPc2State=saved.state;}
});
