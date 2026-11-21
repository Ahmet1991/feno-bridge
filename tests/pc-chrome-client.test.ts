import {test,expect} from 'bun:test';
import {tmpdir} from 'node:os';
import {createUserChromeClient} from '../src/pc-control/chrome';

const windowsTest=process.platform==='win32'?test:test.skip;
windowsTest('own Chrome client returns Turkish action hints and preserves access denied',async()=>{
  let code='pc_chrome_screenshot_required';
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({ok:false,code})});
  const client=createUserChromeClient({readPrivateFile:()=>Buffer.from(JSON.stringify({port:server.port,token:'a'.repeat(64)}))},tmpdir());
  const run=()=>client('computer',{tabId:1,action:'click',x:0,y:0},new AbortController().signal);
  try{
    await expect(run()).rejects.toMatchObject({code,details:{reason:'Önce screenshot al'}});
    code='pc_chrome_disabled';await expect(run()).rejects.toMatchObject({code,details:{reason:'Feno Bridge → Ayarlar → Chrome uzantısı → Chrome erişimini aç'}});
    code='pc_chrome_tab_sleeping';await expect(run()).rejects.toMatchObject({code,details:{reason:expect.stringContaining('pc_chrome_go')}});
    code='pc_access_denied';await expect(run()).rejects.toThrow('pc_access_denied');
  }finally{server.stop(true);}
});
