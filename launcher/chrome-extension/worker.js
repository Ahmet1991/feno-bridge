import {createChromeEngine} from './engine.js';
const host='com.feno.bridge.pc2';
const engine=createChromeEngine(chrome);
let port, retry, running=Promise.resolve();
const operations=new Map();
const version=chrome.runtime.getManifest().version;
function connect() {
  if(port)return;
  try{
    const current=chrome.runtime.connectNative(host);
    port=current;
    current.onDisconnect.addListener(()=>{
      if(port!==current)return;
      void chrome.runtime.lastError;
      port=undefined;
      for(const controller of operations.values())controller.abort();
      void engine.disconnect();
      clearTimeout(retry);retry=setTimeout(connect,2000);
    });
    current.onMessage.addListener(message=>{
      if(message?.type==='reload'&&message.version!==version){chrome.runtime.reload();return;}
      if(message?.type==='cancel'){operations.get(message.id)?.abort();return;}
      if(message?.type!=='command'||typeof message.id!=='string')return;
      const controller=new AbortController();operations.set(message.id,controller);
      const timer=setTimeout(()=>controller.abort(),Math.min(60,Math.max(1,Number(message.args?.timeoutSeconds)||30))*1000);
      running=running.catch(()=>{}).then(async()=>{
        if(port!==current){clearTimeout(timer);operations.delete(message.id);return;}
        let result;
        const badge=Number.isSafeInteger(message.args?.tabId)?{tabId:message.args.tabId}:{};
        try {
          if(!['computer','click','type','upload','js','console','network'].includes(message.action))await chrome.action.setBadgeText({...badge,text:'PC2'}).catch(()=>{});
          if(port!==current)return;
          result={ok:true,data:await engine.run(message.action,message.args||{},controller.signal)};
        }
        catch(error){const code=String(error?.message);result={ok:false,code:/^pc_(chrome_[a-z_]+|invalid_argument)$/.test(code)?code:'pc_chrome_operation_failed',...(typeof error?.reason==='string'?{reason:error.reason.slice(0,4000)}:{})};}
        finally{clearTimeout(timer);operations.delete(message.id);if(!['computer','click','type','upload','js','console','network'].includes(message.action))await chrome.action.setBadgeText({...badge,text:''}).catch(()=>{});}
        if(port===current)current.postMessage({type:'result',id:message.id,...result});
      });
    });
    current.postMessage({type:'hello',version});
  }catch{port=undefined;clearTimeout(retry);retry=setTimeout(connect,2000);}
}
chrome.alarms.create('feno-reconnect',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='feno-reconnect')connect();});
chrome.runtime.onStartup.addListener(()=>{void engine.resetOwnership().then(connect,connect);});
chrome.runtime.onInstalled.addListener(connect);
connect();
