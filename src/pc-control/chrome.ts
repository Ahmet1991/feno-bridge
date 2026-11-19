import {join,isAbsolute} from 'node:path';
import {PcOperationError} from './errors';
import {PcAccessDeniedError} from './authorization';
import type {PcPrivateFileReader} from './types';

const codes = ['pc_chrome_disabled','pc_chrome_not_connected','pc_chrome_tab_not_found','pc_chrome_ref_stale','pc_chrome_screenshot_required','pc_chrome_timeout','pc_chrome_blocked_page','pc_chrome_busy','pc_chrome_operation_failed','pc_chrome_rejected','pc_chrome_js_exception','pc_invalid_argument'] as const;
export function createUserChromeClient(files:PcPrivateFileReader,localAppData=process.env.LOCALAPPDATA){
  return async(action:string,args:Record<string,unknown>,signal:AbortSignal):Promise<any>=>{
    if(process.platform!=='win32'||!localAppData||!isAbsolute(localAppData))throw new PcOperationError('pc_chrome_not_connected');
    let descriptor:{port:number;token:string};
    try{
      descriptor=JSON.parse(files.readPrivateFile(join(localAppData,'Feno Bridge Chrome PC2','chrome-native-descriptor.json'),4096).toString('utf8'));
      if(!Number.isInteger(descriptor.port)||descriptor.port<1||descriptor.port>65535||typeof descriptor.token!=='string'||!/^[a-f0-9]{64}$/.test(descriptor.token))throw Error();
    }catch{throw new PcOperationError('pc_chrome_not_connected');}
    const deadline=AbortSignal.timeout((Number(args.timeoutSeconds)||30)*1000+2000);
    let result:any;
    try{
      const response=await fetch('http://127.0.0.1:'+descriptor.port+'/command',{method:'POST',redirect:'error',
        headers:{authorization:'Bearer '+descriptor.token,'content-type':'application/json'},body:JSON.stringify({action,args}),
        signal:AbortSignal.any([signal,deadline])});
      if(!response.ok)throw Error();
      const body=await response.text();if(body.length>32*1024*1024)throw Error();
      result=JSON.parse(body);
    }catch{throw new PcOperationError(deadline.aborted||signal.aborted?'pc_chrome_timeout':'pc_chrome_not_connected');}
    if(result?.ok!==true){
      if(result?.code==='pc_access_denied')throw new PcAccessDeniedError();
      const code=codes.find(c=>c===result?.code);
      const reason=code==='pc_chrome_disabled'?'Feno Bridge → Ayarlar → Chrome uzantısı → Chrome erişimini aç':code==='pc_chrome_screenshot_required'?'Önce screenshot al':(code==='pc_chrome_rejected'||code==='pc_chrome_js_exception')&&typeof result.reason==='string'?result.reason.slice(0,4000):undefined;
      throw new PcOperationError(code??'pc_chrome_operation_failed',reason?{reason}:undefined);
    }
    const value=result.data;
    if(action==='computer'&&args.action==='screenshot'){
      if(value?.mimeType!=='image/png'||typeof value.base64!=='string')throw new PcOperationError('pc_chrome_operation_failed');
      const data=Buffer.from(value.base64,'base64');
      if(data.length<24||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new PcOperationError('pc_chrome_operation_failed');
      return {mimeType:'image/png',data,title:'Kendi Chrome sekmeniz'};
    }
    return value;
  };
}
