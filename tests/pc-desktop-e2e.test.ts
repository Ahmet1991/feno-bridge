import {afterAll,test,expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import { trackTempDirectories } from './support/temp-directories';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {createPcWindowsController,type PcWindowsHelper} from '../src/pc-control/windows';
import {PcOperationError} from '../src/pc-control/errors';
import {PC_PERMISSIONS} from '../src/pc-control/types';

const mkdtempSync = trackTempDirectories(afterAll);

const e2e=process.platform==='win32'&&process.env.FENO_PC_DESKTOP_E2E==='1'?test:test.skip;
e2e('real desktop E2E touches only the test-owned window; image bytes never hit disk',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'feno-pc2-desktop-e2e-'));
  const title='Feno-PC2-E2E-'+randomUUID(),log=join(directory,'typed.txt'),menuLog=log+'.menu';
  const fixture=join(import.meta.dir,'..','.cache','pc-desktop-test-window.exe');
  const helper=process.env.FENO_PC_DESKTOP_HELPER_EXE||join(import.meta.dir,'..','.cache','pc-windows-helper.exe');
  if(!existsSync(fixture)||!existsSync(helper))throw Error('compiled desktop E2E helpers missing');
  const child=spawn(fixture,['--title',title,'--log',log],{
    windowsHide:false,stdio:['ignore','ignore','pipe'],shell:false,
  });
  let stderr='';child.stderr.on('data',chunk=>{stderr+=(chunk as Buffer).toString('utf8').slice(0,2000);});
  const call:PcWindowsHelper=async(action,args,signal)=>{
    const payload=Buffer.from(JSON.stringify({action,args})).toString('base64');
    return await new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(Error('cancelled'));return;}
      const process=spawn(helper,['--payload',payload],{
        windowsHide:true,stdio:['ignore','pipe','ignore'],shell:false,
      });
      const chunks:Buffer[]=[];let aborted=false;
      const abort=()=>{aborted=true;process.kill();};signal?.addEventListener('abort',abort,{once:true});
      process.stdout.on('data',chunk=>chunks.push(chunk as Buffer));
      process.once('error',reject);
      process.once('close',code=>{
        signal?.removeEventListener('abort',abort);
        if(aborted){reject(Error('cancelled'));return;}
        try{
          const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(code!==0&&data?.reason!=='focus_required')throw Error('helper exit '+code);
          resolve(data);
        }catch(e){reject(e);}
      });
    });
  };
  const authorizer=new PcAuthorizer({profileId:'pc2-normal'});
  authorizer.setGrantFromLocalApproval({profileId:'pc2-normal',id:'desktop-e2e-'+randomUUID(),
    expiresAt:null,fullAccess:true,roots:['C:\\','D:\\'],permissions:[...PC_PERMISSIONS.slice(1)],allowedApps:[]});
  const w=createPcWindowsController({authorizer,runHelper:call});
  try{
    let owned:{id:string;title:string;processName:string}|undefined;
    for(let i=0;i<40;i++){
      if(child.exitCode!==null)throw Error('own fixture exited: '+stderr);
      const list=await w.listPcWindows();owned=list.find(item=>item.title===title&&item.processName==='pc-desktop-test-window.exe');
      if(owned)break;
      await Bun.sleep(100);
    }
    if(!owned)throw Error('own fixture window did not open: '+stderr);
    const png=await w.capturePcWindow(owned.id);
    expect(Buffer.from(png.data).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    const full=await w.captureFull('monitor',0);
    expect(Buffer.from(full.data).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    // A second, fake window cannot be an input target, regardless of focus.
    await expect(w.pcDesktopInput({windowId:'999999',action:'type',text:'MUST_NOT_TYPE'})).rejects.toThrow('pc_access_denied');
    const marker='Çağrı, ılık süt içti — ŞĞÜÖİ D:\\PC2-Test\\a1\\notdefteri3.txt https://example.com/a?q=1&x=2';
    try{await w.pcDesktopInput({windowId:owned.id,action:'type',text:marker});}
    catch(e){
      if(e instanceof PcOperationError&&e.code==='pc_focus_required'){
        // The OS retained another foreground window; no keystroke was sent.
        expect(existsSync(log)).toBe(false);
        process.stdout.write('E2E focus required: isolated capture succeeded, input correctly stopped.\n');return;
      }
      throw e;
    }
    for(let i=0;i<20&&!existsSync(log);i++)await Bun.sleep(50);
    expect(readFileSync(log,'utf8').replace(/^\uFEFF/,'')).toBe(marker);
    await w.pcDesktopInput({windowId:owned.id,action:'right_click',x:40,y:90});
    for(let i=0;i<20&&!existsSync(menuLog);i++)await Bun.sleep(50);
    expect(readFileSync(menuLog,'utf8')).toContain('open\n');
    await w.pcDesktopInput({windowId:owned.id,action:'key',key:'ESC'});
    for(let i=0;i<20&&!readFileSync(menuLog,'utf8').includes('close\n');i++)await Bun.sleep(50);
    expect(readFileSync(menuLog,'utf8')).toMatch(/open\nclose\n/);
    process.stdout.write('E2E own window input and in-memory captures succeeded.\n');
  }finally{
    authorizer.revoke();
    if(child.exitCode===null&&child.signalCode===null){
      const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
      child.kill();await closed;
    }
  }
},45000);
