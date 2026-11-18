import {pageOperation} from './dom.js';
const fail = code => { throw new Error(code); };
const warning = 'Şifre ve ödeme alanları için kullanıcı onayı gerekir.';
export function allowedUrl(raw) {
  try {
    const u = new URL(raw);
    return ['http:','https:'].includes(u.protocol) && !u.username && !u.password &&
      u.hostname !== 'chromewebstore.google.com' && !(u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'));
  } catch { return false; }
}
const keyMap={ENTER:['Enter','Enter',13],ESC:['Escape','Escape',27],TAB:['Tab','Tab',9],SPACE:[' ','Space',32],BACKSPACE:['Backspace','Backspace',8],DELETE:['Delete','Delete',46],UP:['ArrowUp','ArrowUp',38],DOWN:['ArrowDown','ArrowDown',40],LEFT:['ArrowLeft','ArrowLeft',37],RIGHT:['ArrowRight','ArrowRight',39],HOME:['Home','Home',36],END:['End','End',35],PAGEUP:['PageUp','PageUp',33],PAGEDOWN:['PageDown','PageDown',34]};
export function createChromeEngine(chrome,{idleMs=15000}={}) {
  const sessions=new Map(), shots=new Map(), refs=new Map(), cursors=new Map();
  let epoch=0;
  const invalidate=id=>{shots.delete(id);refs.delete(id);};
  async function detach(id) {
    const s=sessions.get(id); if(!s)return;
    clearTimeout(s.timer);sessions.delete(id);
    try { await chrome.debugger.detach({tabId:id}); } catch {}
    await chrome.action.setBadgeText({tabId:id,text:''}).catch(()=>{});
  }
  async function run(action,a,signal) {
  const runEpoch=epoch;
  const check=()=>{if(signal?.aborted)fail('pc_chrome_timeout');if(epoch!==runEpoch)fail('pc_chrome_not_connected');};
  async function wait(promise) {
    check();
    if(!signal)return promise;
    let abort;
    try{return await Promise.race([promise,new Promise((_,reject)=>{abort=()=>reject(new Error('pc_chrome_timeout'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}
    finally{signal.removeEventListener('abort',abort);}
  }
  async function tab(id) {
    check();
    if (!Number.isSafeInteger(id)||id<0) fail('pc_chrome_tab_not_found');
    let t; try { t=await wait(chrome.tabs.get(id)); } catch { check();fail('pc_chrome_tab_not_found'); }
    check();
    if (t.incognito || !allowedUrl(t.url) || (t.pendingUrl && !allowedUrl(t.pendingUrl))) fail('pc_chrome_blocked_page');
    return t;
  }
  async function page(id,action,args) {
    await tab(id);
    try {
      const [v]=await wait(chrome.scripting.executeScript({target:{tabId:id},func:pageOperation,args:[action,args||{}],world:'ISOLATED'}));
      check();return v?.result;
    } catch { check();fail('pc_chrome_blocked_page'); }
  }
  async function command(id,method,params={}) {
    await tab(id);
    const result=await wait(chrome.debugger.sendCommand({tabId:id},method,params));check();return result;
  }
  async function using(id,fn) {
    await tab(id);
    let s=sessions.get(id);
    if(!s) {
      await chrome.debugger.attach({tabId:id},'1.3');
      s={};sessions.set(id,s);
      if(epoch!==runEpoch||signal?.aborted){await detach(id);check();}
      await chrome.action.setBadgeText({tabId:id,text:'PC2'});
    }
    clearTimeout(s.timer);
    try {
      check();
      return await fn();
    } finally {
      if(sessions.get(id)===s){if(signal?.aborted||epoch!==runEpoch){invalidate(id);await detach(id);}else s.timer=setTimeout(()=>void detach(id),idleMs);}
    }
  }
  async function cursor(id,p,click=false) {
    cursors.set(id,p);
    await page(id,'cursor',{...p,click});
  }
  const same=(a,b)=>a&&b&&a.id===b.id&&['width','height','pageX','pageY','scale','dpr'].every(k=>Math.abs(a[k]-b[k])<0.01);
  async function screenshot(id,includeCursor) {
    shots.delete(id);
    const v=await page(id,'viewport');
    if(!includeCursor&&cursors.has(id))await page(id,'cursor',{hide:true});
    let shot;
    try{shot=await command(id,'Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});}
    finally{if(!includeCursor&&cursors.has(id))await page(id,'cursor',{restore:true}).catch(()=>{});}
    const bytes=Uint8Array.from(atob(shot.data.slice(0,32)),c=>c.charCodeAt(0));
    const view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20);
    if(!width||!height||!same(v,await page(id,'viewport'))) fail('pc_chrome_ref_stale');
    shots.set(id,{v,width,height});
    return {mimeType:'image/png',base64:shot.data,width,height,title:'Kendi Chrome sekmeniz'};
  }
  async function point(id,x,y) {
    const s=shots.get(id);
    if(!s)fail('pc_chrome_screenshot_required');
    if(!same(s.v,await page(id,'viewport'))) fail('pc_chrome_ref_stale');
    if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=s.width||y>=s.height)fail('pc_invalid_argument');
    return {x:x*s.v.width/s.width,y:y*s.v.height/s.height};
  }
  async function guard(id,p) {
    const result=await page(id,'guard',{point:p});
    if(!result||result.blocked)fail('pc_chrome_blocked_page');
    return result.sensitive;
  }
  const mouse=(id,type,p,extra={})=>command(id,'Input.dispatchMouseEvent',{type,...p,...extra});
  async function click(id,p,button='left',count=1) {
    await cursor(id,p,true);await mouse(id,'mouseMoved',p);
    for(let i=1;i<=count;i++) {
      await mouse(id,'mousePressed',p,{button,buttons:button==='right'?2:1,clickCount:i});
      await mouse(id,'mouseReleased',p,{button,buttons:0,clickCount:i});
    }
  }
  async function key(id,k) {
    k=String(k).toUpperCase();if(k==='ESCAPE')k='ESC';
    const item=keyMap[k];if(!item)fail('pc_invalid_argument');
    const [key,code,windowsVirtualKeyCode]=item;
    const params={key,code,windowsVirtualKeyCode};
    await command(id,'Input.dispatchKeyEvent',{type:'keyDown',...params,...(k==='ENTER'?{text:'\r'}:k==='SPACE'?{text:' '}: {})});
    await command(id,'Input.dispatchKeyEvent',{type:'keyUp',...params});
  }
  async function computer(id,a) {
    if(a.action==='screenshot')return screenshot(id,a.includeCursor===true);
    const p=a.x===undefined?undefined:await point(id,a.x,a.y);
    if(!p&&!['type','key'].includes(a.action))fail('pc_invalid_argument');
    let sensitive=p?await guard(id,p):false;
    if(['click','double_click','right_click'].includes(a.action))await click(id,p,a.action==='right_click'?'right':'left',a.action==='double_click'?2:1);
    else if(a.action==='hover'){await cursor(id,p);await mouse(id,'mouseMoved',p);}
    else if(a.action==='scroll'){await cursor(id,p);return {ok:true,...await page(id,'scroll',{point:p,deltaX:a.deltaX??0,delta:a.delta??600})};}
    else if(a.action==='drag'){
      const end=await point(id,a.endX,a.endY);sensitive=(await guard(id,end))||sensitive;
      await cursor(id,p,true);await mouse(id,'mouseMoved',p);await mouse(id,'mousePressed',p,{button:'left',buttons:1,clickCount:1});
      let last=p;
      try{for(let i=1;i<=12;i++){last={x:p.x+(end.x-p.x)*i/12,y:p.y+(end.y-p.y)*i/12};await cursor(id,last);await mouse(id,'mouseMoved',last,{button:'left',buttons:1});}}
      finally{await mouse(id,'mouseReleased',last,{button:'left',buttons:0,clickCount:1});}
    } else if(a.action==='type'||a.action==='key'){
      if(sensitive)return {ok:false,warning};
      if(p)await click(id,p);
      if(await guard(id))return {ok:false,warning};
      if(a.action==='type')await command(id,'Input.insertText',{text:a.text});else await key(id,a.key);
    } else fail('pc_invalid_argument');
    return {ok:true,...(sensitive?{warning}:{})};
  }
    check();
    if(action==='tabs'){
      const windows=await wait(chrome.windows.getAll({populate:true,windowTypes:['normal']}));check();
      return {windows:windows.filter(w=>!w.incognito).map(w=>({windowId:w.id,focused:w.focused,tabs:(w.tabs||[]).filter(t=>!t.incognito&&allowedUrl(t.url)).map(t=>({tabId:t.id,title:t.title||'',domain:new URL(t.url).hostname,active:t.active}))}))};
    }
    if(action==='open'){
      if(!allowedUrl(a.url))fail('pc_chrome_blocked_page');
      const t=await wait(chrome.tabs.create({url:a.url,active:false}));check();return {tabId:t.id,domain:new URL(a.url).hostname};
    }
    const id=a.tabId,t=await tab(id),domain=new URL(t.url).hostname;
    if(action==='navigate'){
      if(!allowedUrl(a.url))fail('pc_chrome_blocked_page');
      invalidate(id);await detach(id);check();await chrome.tabs.update(id,{url:a.url});return {ok:true,domain:new URL(a.url).hostname};
    }
    if(action==='read'||action==='find'){
      const result=await page(id,action,a);refs.set(id,result.documentId);delete result.documentId;
      return {...result,domain};
    }
    // DOM scrolling does not need a debugger attachment.
    if(action==='computer'&&a.x!==undefined&&!shots.has(id))fail('pc_chrome_screenshot_required');
    if(action==='computer'&&a.action==='scroll'&&!sessions.has(id))return {...await computer(id,a),domain};
    const result=await using(id,async()=>{
      if(action==='computer')return computer(id,a);
      if(!['click','type'].includes(action))fail('pc_invalid_argument');
      const p=await page(id,'ref',{ref:a.ref,documentId:refs.get(id)});
      if(!p)fail('pc_chrome_ref_stale');
      if(action==='type'&&(p.sensitive||await guard(id,p)))return {ok:false,warning};
      await click(id,{x:p.x,y:p.y});
      if(action==='type'){
        if(await guard(id))return {ok:false,warning};
        await command(id,'Input.insertText',{text:a.text});
      }
      return {ok:true,...(p.sensitive?{warning}:{})};
    });
    return {...result,domain};
  }
  chrome.tabs.onUpdated.addListener((id,change)=>{
    if(change.status==='loading'||change.url)invalidate(id);
    if(change.status==='complete')cursors.delete(id);
  });
  chrome.tabs.onRemoved.addListener(id=>{invalidate(id);cursors.delete(id);void detach(id);});
  chrome.debugger.onDetach.addListener(({tabId:id})=>{
    const s=sessions.get(id);if(s)clearTimeout(s.timer);sessions.delete(id);
    void chrome.action.setBadgeText({tabId:id,text:''}).catch(()=>{});
  });
  return {run,disconnect:async()=>{epoch++;shots.clear();refs.clear();cursors.clear();await Promise.all([...sessions.keys()].map(detach));}};
}
