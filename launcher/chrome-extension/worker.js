import {createChromeEngine} from './engine.js';
const host='com.feno.bridge.pc2';
const engine=createChromeEngine(chrome);
let port, retry, running=Promise.resolve();
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
      void engine.disconnect();
      clearTimeout(retry);retry=setTimeout(connect,2000);
    });
    current.onMessage.addListener(message=>{
      if(message?.type==='reload'&&message.version!==version){chrome.runtime.reload();return;}
      if(message?.type!=='command'||typeof message.id!=='string')return;
      running=running.catch(()=>{}).then(async()=>{
        if(port!==current)return;
        let result;
        const badge=Number.isSafeInteger(message.args?.tabId)?{tabId:message.args.tabId}:{};
        try {
          await chrome.action.setBadgeText({...badge,text:'PC2'}).catch(()=>{});
          if(port!==current)return;
          result={ok:true,data:await engine.run(message.action,message.args||{})};
        }
        catch(error){const code=String(error?.message);result={ok:false,code:/^pc_(chrome_[a-z_]+|invalid_argument)$/.test(code)?code:'pc_chrome_operation_failed'};}
        finally{if(!['computer','click','type'].includes(message.action))await chrome.action.setBadgeText({...badge,text:''}).catch(()=>{});}
        if(port===current)current.postMessage({type:'result',id:message.id,...result});
      });
    });
    current.postMessage({type:'hello',version});
  }catch{port=undefined;clearTimeout(retry);retry=setTimeout(connect,2000);}
}
chrome.alarms.create('feno-reconnect',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='feno-reconnect')connect();});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
