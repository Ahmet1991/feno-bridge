import {afterAll,test,expect} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdirSync,writeFileSync} from 'node:fs';
import { trackTempDirectories } from './support/temp-directories';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {defaultConfig} from '../src/config';

const mkdtempSync = trackTempDirectories(afterAll);

const e2e=process.platform==='win32'&&process.env.FENO_PC_ADB_E2E==='1'?test:test.skip;
e2e('isolated signed MCP permission controls only Android 15 emulator through real adb',async()=>{
  const sdk=join(process.env.LOCALAPPDATA||'', 'Android','Sdk');
  const adb=join(sdk,'platform-tools','adb.exe');
  const serial='emulator-5554';
  const root=mkdtempSync(join(tmpdir(),'pc-adb-e2e-'));
  const home=join(root,'home'),ui=join(root,'ui'),coord=join(root,'coord'),approvedRoot=join(root,'fixture');
  mkdirSync(home);mkdirSync(ui);mkdirSync(approvedRoot);
  const broker='\\\\.\\pipe\\pc-adb-e2e-'+randomUUID();
  writeFileSync(join(home,'config.json'),JSON.stringify({...defaultConfig('browser-only'),brokerSocketPath:broker}));
  const {createPcLauncherService}=require('../launcher/electron/pc-service.cjs');
  const service=createPcLauncherService({profile:{kind:'production',coreHome:home,userData:ui},sharedDirectory:coord,
    confirmLocally:async()=>true,
    testPeerEvidence:{inspectDevLaunchers:()=>({state:'absent',pids:[]}),devInstallPaths:[join(root,'dev-install')],devHome:join(root,'dev')}});
  service.start();
  await service.approve({durationMs:60000,roots:[approvedRoot],permissions:['adb'],allowedApps:[]});
  const transport=new StdioClientTransport({command:process.execPath,
    args:['--preload',join(import.meta.dir,'fixtures','pc-no-dev-host-preload.cjs'),join(import.meta.dir,'../src/cli.ts'),'mcp','--contract','native','--broker-socket',broker],
    env:{...process.env as Record<string,string>,ANDROID_HOME:sdk,CODEX_CHATGPT_WEB_HOME:home,
      CODEX_WEB_GPT_DEV_HOME:join(root,'dev'),FENO_PC_COORDINATION_DIR:coord,
      LOCALAPPDATA:join(root,'appdata'),ProgramFiles:join(root,'programs'),'ProgramFiles(x86)':join(root,'programs-x86')},stderr:'pipe'});
  const client=new Client({name:'isolated-adb-emulator',version:'1'});
  const call=async(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
  const good=async(name:string,args:Record<string,unknown>={})=>{
    const result=await call(name,args);
    if(result.isError)throw Error(`${name}: ${JSON.stringify(result.structuredContent)}`);
    return result;
  };
  const png=async()=>{
    const result=await good('pc_adb_screencap',{serial});
    const item=(result.content as Array<{type:string;data?:string}>).find(x=>x.type==='image');
    if(!item||item.type!=='image'||typeof item.data!=='string')throw Error('MCP image missing');
    const bytes=Buffer.from(item.data,'base64');
    expect(bytes.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect(bytes.readUInt32BE(16)).toBe(1080);
    expect(bytes.readUInt32BE(20)).toBe(2400);
    return bytes;
  };
  const adbShell=(...args:string[])=>{
    const result=spawnSync(adb,['-s',serial,'shell',...args],{windowsHide:true,encoding:'utf8',timeout:15000});
    if(result.status!==0)throw Error(`adb shell failed: ${result.status} ${result.stderr}`);
    return result.stdout;
  };
  try{
    await client.connect(transport);
    expect((await good('pc_status')).structuredContent).toMatchObject({ok:true,enabled:true});
    const devices=(await good('pc_adb_devices')).structuredContent as any;
    expect(devices.data).toContainEqual({serial,state:'device'});
    expect(adbShell('getprop','ro.build.version.release').trim()).toBe('15');
    const first=await png();
    await good('pc_adb_input',{serial,action:'key',value:'KEYCODE_HOME'});
    adbShell('am','start','-a','android.settings.SETTINGS');
    await Bun.sleep(900);
    await good('pc_adb_input',{serial,action:'tap',x:535,y:192});
    await good('pc_adb_input',{serial,action:'text',value:'FenoTest'});
    const second=await png();
    expect(second.equals(first)).toBeFalse();
    const denied=await call('pc_adb_input',{serial:'192.168.1.103:5555',action:'key',value:'KEYCODE_HOME'});
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ok:false,code:'pc_access_denied'});
    process.stdout.write('ADB_E2E_OK MCP signed grant + devices + PNG1080x2400 + HOME/tap/text + emulator-only denial\n');
  }finally{await client.close();service.suspend();}
},65000);
