import {test,expect} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {defaultConfig} from '../src/config';
import {canonicalTemp} from './support/canonical-temp';
const pcNames=['pc_status','pc_list_files','pc_read_file','pc_write_patch','pc_create_file','pc_create_directory','pc_start_job','pc_list_project_tasks','pc_start_project_task','pc_start_terminal','pc_job_status','pc_job_logs','pc_cancel_job','pc_list_jobs',
  'pc_list_windows','pc_capture_screen','pc_desktop_input','pc_clipboard_read','pc_clipboard_write','pc_adb_devices','pc_adb_screencap','pc_adb_input','pc_runner_status','pc_launch_app','pc_capture_full_screen','pc_show_image',
  ...['open','tabs','navigate','back','forward','reload','read','find','click','type','key','scroll','screenshot','close_tab','download_dir','show','hide','mode','computer'].map(action=>'pc_browser_'+action), ...['tabs','open','navigate','read','find','computer','click','type','close','go','form','upload','js','console','network'].map(action=>'pc_chrome_'+action)].sort();
test('native MCP advertises all desktop tools and denies unauthenticated use without changing six Codex schemas',async()=>{
  const home=mkdtempSync(join(tmpdir(),'pc-core-mcp-'));
  const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/cli.ts'),'mcp','--contract','native','--broker-socket',process.platform==='win32'?'\\\\.\\pipe\\pc-core-'+randomUUID():join(home,'broker.sock')],cwd:home,env:{...process.env as Record<string,string>,HOME:home,USERPROFILE:home,CODEX_CHATGPT_WEB_HOME:home,CODEX_HOME:join(home,'codex'),CODEX_WEB_GPT_DEV_HOME:join(home,'dev'),CODEX_CHATGPT_WEB_PRODUCTION_HOME:join(home,'production'),FENO_PC_COORDINATION_DIR:join(home,'coord')},stderr:'pipe'});
  const client=new Client({name:'isolated-pc-core',version:'1'});
  try{
    await client.connect(transport);const {tools}=await client.listTools();
    console.log('TOOLS_LIST_BYTES',Buffer.byteLength(JSON.stringify({tools}),'utf8'),'COUNT',tools.length);
    expect(tools.filter(t=>t.name.startsWith('pc_')).map(t=>t.name).sort()).toEqual(pcNames);
    const resources=await client.listResources();
    expect(resources.resources.some(r=>r.uri==='ui://widget/pc-screenshot-v5.1.28.html')).toBe(true);
    expect(resources.resources.some(r=>r.uri==='ui://widget/probe-mcpapp-v5.1.28.html')).toBe(true);
    expect(resources.resources.some(r=>r.uri==='ui://widget/probe-skybridge-v5.1.28.html')).toBe(true);
    for(const name of ['pc_capture_screen','pc_capture_full_screen','pc_adb_screencap','pc_show_image','pc_browser_screenshot','pc_browser_computer','pc_chrome_computer']){
      expect(tools.find(t=>t.name===name)?._meta?.['openai/outputTemplate']).toBe('ui://widget/pc-screenshot-skybridge-v5.1.28.html');
      expect(tools.find(t=>t.name===name)?._meta?.ui).toMatchObject({resourceUri:'ui://widget/pc-screenshot-v5.1.28.html'});
    }
    const schema=(name:string)=>tools.find(t=>t.name===name)!.inputSchema;
    expect(Object.keys(schema('pc_launch_app').properties??{})).toContain('filePath');
    expect(Object.keys(schema('pc_launch_app').properties??{})).toContain('userDataDir');
    expect(Object.keys(schema('pc_start_terminal').properties??{})).toContain('timeoutSeconds');
    expect(Object.keys(schema('pc_start_job').properties??{})).toContain('timeoutSeconds');
    expect(tools.filter(t=>t.name.startsWith('codex_'))).toHaveLength(6);
    const status=await client.callTool({name:'pc_status',arguments:{}});
    expect(status.structuredContent).toMatchObject({ok:true,enabled:false});
    for(const [name,args] of [['pc_list_files',{path:home}],['pc_read_file',{path:join(home,'x')}],['pc_create_file',{path:join(home,'x'),content:'fixture'}],['pc_start_terminal',{projectRoot:home,command:'echo fixture',purpose:'test command'}],
      ['pc_list_windows',{}],['pc_capture_screen',{windowId:'123'}],['pc_capture_full_screen',{mode:'all'}],['pc_show_image',{path:join(home,'x.png')}],['pc_desktop_input',{windowId:'123',action:'click',x:1,y:1}],['pc_clipboard_read',{}],['pc_clipboard_write',{text:'fixture'}],
      ['pc_adb_devices',{}],['pc_adb_screencap',{serial:'emulator-5554'}],['pc_adb_input',{serial:'emulator-5554',action:'tap',x:1,y:2}],['pc_runner_status',{label:'fenotip-tv'}],['pc_launch_app',{app:'chrome.exe'}]] as const){
      const denied=await client.callTool({name,arguments:args});expect(denied.isError).toBe(true);expect(denied.structuredContent).toMatchObject({ok:false,code:'pc_access_denied'});
    }
    const invalid=await client.callTool({name:'pc_read_file',arguments:{}});expect(invalid.isError).toBe(true);
    const browserDenied=await client.callTool({name:'pc_browser_open',arguments:{url:'http://127.0.0.1/'}});
    expect(browserDenied.structuredContent).toMatchObject({ok:false,code:'pc_access_denied'});
    const computerDenied=await client.callTool({name:'pc_browser_computer',arguments:{tabId:'t1',action:'click',x:0,y:0}});
    expect(computerDenied.structuredContent).toMatchObject({ok:false,code:'pc_access_denied'});
    for(const key of ['Enter','enter','Esc','Escape','eScApE']){
      for(const [name,args] of [['pc_browser_key',{tabId:'t1',key}],['pc_browser_computer',{tabId:'t1',action:'key',key}],['pc_chrome_computer',{tabId:1,action:'key',key}]] as const){
        expect((await client.callTool({name,arguments:args})).structuredContent).toMatchObject({code:'pc_access_denied'});
      }
    }
    expect((await client.callTool({name:'pc_browser_computer',arguments:{tabId:'t1',action:'drag',x:0,y:0}})).isError).toBe(true);
  }finally{await client.close();}
},15000);

const windowsTest=process.platform==='win32'?test:test.skip;
windowsTest('signed local approval drives real MCP files, project tasks, terminal logs, revoke and full cleanup',async()=>{
  const root=canonicalTemp('pc-core-flow-'),home=join(root,'home'),project=join(root,'project'),ui=join(root,'ui'),coord=join(root,'coord');
  for(const dir of [home,project,ui])mkdirSync(dir);
  const broker='\\\\.\\pipe\\pc-flow-'+randomUUID();
  writeFileSync(join(home,'config.json'),JSON.stringify({...defaultConfig('browser-only'),brokerSocketPath:broker}));
  writeFileSync(join(project,'package.json'),JSON.stringify({scripts:{test:'echo project-fixture',typecheck:'node -e "setTimeout(()=>{},30000)"'}}));
  const {createPcLauncherService}=require('../launcher/electron/pc-service.cjs');
  const service=createPcLauncherService({profile:{kind:'production',coreHome:home,userData:ui},sharedDirectory:coord,confirmLocally:async()=>true,
    testPeerEvidence:{inspectDevLaunchers:()=>({state:'absent',pids:[]}),devInstallPaths:[join(root,'dev-install')],devHome:join(root,'dev')}});service.start();
  await service.approve({durationMs:60000,roots:[project],permissions:['files.read','files.write','jobs','terminal.exec'],allowedApps:[]});
  const transport=new StdioClientTransport({command:process.execPath,args:['--preload',join(import.meta.dir,'fixtures/pc-no-dev-host-preload.cjs'),join(import.meta.dir,'../src/cli.ts'),'mcp','--contract','native','--broker-socket',broker],
    env:{...process.env as Record<string,string>,CODEX_CHATGPT_WEB_HOME:home,CODEX_WEB_GPT_DEV_HOME:join(root,'dev'),FENO_PC_COORDINATION_DIR:coord,
      LOCALAPPDATA:join(root,'appdata'),ProgramFiles:join(root,'programs'),'ProgramFiles(x86)':join(root,'programs-x86')},stderr:'pipe'});
  const client=new Client({name:'isolated-pc-flow',version:'1'});
  const data=async(name:string,args:Record<string,unknown>={})=>{
    const r=await client.callTool({name,arguments:args});
    if(r.isError){
      const current=await client.callTool({name:'pc_status',arguments:{}});
      throw Error(JSON.stringify({tool:name,error:r.structuredContent,status:current.structuredContent}));
    }
    return r.structuredContent as any;
  };
  async function finished(jobId:string){const until=Date.now()+12000;for(;;){const s=(await data('pc_job_status',{jobId})).data;if(s.state!=='running')return s;if(Date.now()>until)throw Error('fixture job did not finish');await Bun.sleep(30);}}
  try{
    await client.connect(transport);expect(await data('pc_status')).toMatchObject({enabled:true,coordinationReady:true});
    const file=join(project,'fixture.txt');await data('pc_create_file',{path:file,content:'old\r\n'});
    const read=(await data('pc_read_file',{path:file})).data;expect(read.content).toBe('old\r\n');
    await data('pc_write_patch',{path:file,sha256:read.sha256,patch:'@@ -1 +1 @@\n-old\n+new\n'});expect(readFileSync(file,'utf8')).toBe('new\r\n');
    const task=(await data('pc_start_project_task',{projectRoot:project,taskId:'script:test'})).data;expect(await finished(task.jobId)).toMatchObject({state:'succeeded',exitCode:0});
    const terminal=(await data('pc_start_terminal',{projectRoot:project,command:'Write-Output "token=fixture-private"; exit 23',purpose:'isolated terminal verification'})).data;
    expect(await finished(terminal.jobId)).toMatchObject({state:'failed',exitCode:23});
    const history=(await data('pc_list_jobs')).data;
    expect(history[0]).toMatchObject({jobId:terminal.jobId,kind:'terminal',state:'failed',exitCode:23,projectRoot:project,purpose:'isolated terminal verification'});
    expect(history[0].commandHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(history)).not.toContain('fixture-private');
    const lines=(await data('pc_job_logs',{jobId:terminal.jobId})).data.lines.join('\n');expect(lines).toContain('[REDACTED]');expect(lines).not.toContain('fixture-private');
    const cancellable=(await data('pc_start_job',{projectRoot:project,kind:'typecheck'})).data;
    expect((await data('pc_cancel_job',{jobId:cancellable.jobId})).data).toBeDefined();
    expect((await finished(cancellable.jobId)).state).toBe('cancelled');
    const running=(await data('pc_start_terminal',{projectRoot:project,command:'Write-Output ("fixture_pid="+$PID); Start-Sleep 30',purpose:'isolated revoke verification'})).data;
    expect(await data('pc_status')).toMatchObject({terminalBusy:true});
    let pid=0;const until=Date.now()+10000;
    while(!pid){const output=(await data('pc_job_logs',{jobId:running.jobId})).data.lines.join('\n');pid=Number(/fixture_pid=(\d+)/.exec(output)?.[1]);if(Date.now()>until)throw Error('fixture pid absent');await Bun.sleep(25);}
    service.revoke();
    const native=require('../launcher/electron/private-acl-native.cjs');
    for(let end=Date.now()+10000;native.inspectProcess(pid).state==='alive';){if(Date.now()>end)throw Error('revoked fixture process survived');await Bun.sleep(25);}
    expect(await data('pc_status')).toMatchObject({enabled:false});
    const denied=await client.callTool({name:'pc_job_logs',arguments:{jobId:running.jobId}});expect(denied.structuredContent).toMatchObject({code:'pc_access_denied'});
    const cannotRetire=await client.callTool({name:'pc_retire_dev',arguments:{retired:true}});
    expect(cannotRetire.isError).toBe(true);
  }finally{await client.close();service.suspend();}
},35000);
