import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import {PcAccessDeniedError,PcAuthorizer} from './authorization';
import {PcOperationError} from './errors';
import {applyPcPatch,createPcDirectory,createPcFile,listPcFiles,readPcFile} from './files';
import {createPcJobManager,createPcJobResources,inferPcCommandSpecs,type PcJobKind,type PcJobManagerOptions} from './jobs';
import {inferPcDeveloperTasks} from './developer-tasks';
import {resolveAllowedPath} from './paths';
import {randomUUID} from 'node:crypto';
import {createPcWindowsController,pcWindowsHelperStatus,type PcDesktopInput,type PcWindowsHelper} from './windows';
import {createPcAdbController,resolveTrustedAdbPath,type PcAdbInput,type PcAdbRun} from './adb';
import {createPcApplicationLauncher,type PcLaunchableApp} from './launch';
import {createConfiguredGithubRunnerProbe,getRunnerStatus,type PcRunnerProbe} from './runner';
import type {PcHostLease} from './resource-locks';
export interface PcHost {
  status():Promise<object>;listFiles(path:string):Promise<unknown>;readFile(path:string):Promise<unknown>;
  applyPatch(path:string,sha:string,patch:string):Promise<unknown>;createFile(path:string,content:string):Promise<unknown>;createDirectory(path:string):Promise<unknown>;
  startJob(kind:PcJobKind,root:string):Promise<unknown>;listProjectTasks(root:string):Promise<unknown>;startProjectTask(root:string,id:string):Promise<unknown>;
  startTerminal(root:string,command:string,purpose:string):Promise<unknown>;jobStatus(id:string):Promise<unknown>;jobLogs(id:string,cursor:number):Promise<unknown>;cancelJob(id:string):Promise<unknown>;
  revokeActiveJobs():Promise<void>;
  listWindows?():Promise<unknown>;captureScreen?(id:string):Promise<{mimeType:'image/png';data:Uint8Array}>;
  captureFullScreen?(mode:'all'|'monitor',monitor?:number):Promise<{mimeType:'image/png';data:Uint8Array}>;
  desktopInput?(input:PcDesktopInput):Promise<unknown>;
  adbDevices?():Promise<unknown>;adbInput?(serial:string,input:PcAdbInput):Promise<unknown>;
  adbScreencap?(serial:string):Promise<Uint8Array>;runnerStatus?():Promise<unknown>;
  launchApp?(app:string,url?:string):Promise<unknown>;
}
export function createLocalPcHost(authorizer:PcAuthorizer,options:Pick<PcJobManagerOptions,'auditCommand'>&{
  acquireLease:(operation:'job'|'terminal'|'desktop-input'|'adb',operationId:string)=>Promise<PcHostLease>;
  coordinationReady?:()=>boolean;jobTimeoutMs?:number;terminalTimeoutMs?:number;runnerDirectory?:string;
  windowsHelper?:PcWindowsHelper;isInteractive?:()=>Promise<boolean>;
  adbPath?:string;adbRun?:PcAdbRun;
  launchResolve?:(app:PcLaunchableApp)=>string|undefined;launchSpawn?:(executable:string,args:string[])=>void|Promise<void>;
  runnerProbe?:PcRunnerProbe;
}):PcHost{
  const resources=createPcJobResources();type Manager=ReturnType<typeof createPcJobManager>;
  const managers=new Map<string,{manager:Manager;tasks:string[]}>(),owners=new Map<string,Manager>();let activeGrant:string|undefined;
  const retired=new Set<Promise<void>>();let cleanupFailed=false;
  const actions=new Set<AbortController>();
  async function runGuarded<T>(permission:'screen.read'|'screen.full'|'desktop.input'|'adb'|'apps.launch',
    action:(signal:AbortSignal)=>Promise<T>,leased?:'desktop-input'|'adb'):Promise<T>{
    const id=authorizer.assert(permission).id;
    const controller=new AbortController();actions.add(controller);
    let lease:Awaited<ReturnType<typeof options.acquireLease>>|undefined;
    try{
      if(leased)lease=await options.acquireLease(leased,randomUUID());
      if(controller.signal.aborted||authorizer.assert(permission).id!==id)throw new PcAccessDeniedError();
      const result=await action(controller.signal);
      if(controller.signal.aborted||authorizer.assert(permission).id!==id)throw new PcAccessDeniedError();
      return result;
    }finally{
      actions.delete(controller);
      if(lease)await lease.releaseAfterExit(Promise.resolve());
    }
  }
  const windowController=(signal:AbortSignal)=>createPcWindowsController({authorizer,signal,runHelper:options.windowsHelper,isInteractive:options.isInteractive});
  const adbController=(signal:AbortSignal)=>{
    const adbPath=options.adbPath??resolveTrustedAdbPath();if(!adbPath)throw new PcAccessDeniedError();
    return createPcAdbController({authorizer,adbPath,signal,runCommand:options.adbRun});
  };
  const retire=()=>{
    for(const action of actions)action.abort();
    const old=[...managers.values()];managers.clear();owners.clear();activeGrant=undefined;
    const completion=Promise.all(old.map(e=>e.manager.revokeAll())).then(()=>{});
    retired.add(completion);void completion.then(()=>retired.delete(completion),()=>{cleanupFailed=true;retired.delete(completion);});return completion;
  };
  function forProject(root:string){
    const grant=authorizer.assert('jobs'),canonical=resolveAllowedPath(root,grant.roots,{fullAccess:grant.fullAccess});
    if(grant.id!==activeGrant){void retire().catch(()=>{});activeGrant=grant.id;}
    if(cleanupFailed)throw new PcOperationError('pc_resource_recovery_required');
    if(managers.has(canonical))return managers.get(canonical)!;
    if(managers.size>=16)throw new PcAccessDeniedError();
    const specs=inferPcDeveloperTasks(canonical),manager=createPcJobManager({projectRoot:canonical,profileId:authorizer.profileId,
      commandSpecs:{...inferPcCommandSpecs(canonical),...specs},resources,acquireLease:options.acquireLease,auditCommand:options.auditCommand,
      jobTimeoutMs:options.jobTimeoutMs,terminalTimeoutMs:options.terminalTimeoutMs});
    const entry={manager,tasks:Object.keys(specs).sort()};managers.set(canonical,entry);return entry;
  }
  function job(id:string){const grant=authorizer.assert('jobs');const manager=owners.get(id);if(!manager||grant.id!==activeGrant)throw new PcAccessDeniedError();return manager;}
  async function start(root:string,action:(manager:Manager)=>Promise<{jobId:string}>){
    const entry=forProject(root),grantId=activeGrant;const result=await action(entry.manager);
    try{if(authorizer.assert('jobs').id!==grantId||activeGrant!==grantId)throw new PcAccessDeniedError();}
    catch(error){await entry.manager.revokeAll();throw error;}
    owners.set(result.jobId,entry.manager);return result;
  }
  return {
    status:async()=>({platform:process.platform,coordinationReady:options.coordinationReady?.()===true,cleanupRequired:cleanupFailed,
      desktop:options.windowsHelper?{available:true,source:'injected'}:pcWindowsHelperStatus(),
      ...(authorizer.assert('status')?.permissions.includes('jobs')?{activeJobs:resources.activeJobCount(),terminalBusy:resources.hasActiveTerminal()}: {})}),
    listFiles:p=>listPcFiles(p,'.',authorizer),readFile:p=>readPcFile(p,authorizer),applyPatch:(p,s,v)=>applyPcPatch(p,s,v,authorizer),
    createFile:(p,c)=>createPcFile(p,c,authorizer),createDirectory:p=>createPcDirectory(p,authorizer),
    startJob:(kind,projectRoot)=>start(projectRoot,m=>m.startPcJob({kind,projectRoot},authorizer)),
    listProjectTasks:async root=>forProject(root).tasks,
    startProjectTask:(projectRoot,taskId)=>start(projectRoot,async m=>{if(!forProject(projectRoot).tasks.includes(taskId))throw new PcAccessDeniedError();return m.startDeveloperTask({projectRoot,taskId},authorizer);}),
    startTerminal:(projectRoot,command,purpose)=>{authorizer.assert('terminal.exec');return start(projectRoot,m=>m.startTerminalCommand({projectRoot,command,purpose},authorizer));},
    jobStatus:async id=>job(id).pcJobStatus(id,authorizer),jobLogs:async(id,cursor)=>job(id).pcJobLogs(id,cursor,authorizer),
    cancelJob:async id=>{await job(id).cancelPcJob(id,authorizer);return {cancelled:true};},
    revokeActiveJobs:async()=>{await retire();await Promise.all([...retired]);},
    listWindows:()=>runGuarded('screen.read',signal=>windowController(signal).listPcWindows()),
    captureScreen:id=>runGuarded('screen.read',signal=>windowController(signal).capturePcWindow(id)),
    captureFullScreen:(mode,monitor)=>runGuarded('screen.full',signal=>windowController(signal).captureFull(mode,monitor)),
    desktopInput:input=>runGuarded('desktop.input',signal=>windowController(signal).pcDesktopInput(input),'desktop-input'),
    adbDevices:()=>runGuarded('adb',signal=>adbController(signal).adbDevices()),
    adbInput:(serial,input)=>runGuarded('adb',signal=>adbController(signal).adbInput(serial,input),'adb'),
    adbScreencap:serial=>runGuarded('adb',signal=>adbController(signal).adbScreenshot(serial),'adb'),
    runnerStatus:async()=>{
      const id=authorizer.assert('runner').id;
      const state=await getRunnerStatus({label:'fenotip-tv'},options.runnerProbe??(options.runnerDirectory?createConfiguredGithubRunnerProbe(options.runnerDirectory):undefined));
      if(authorizer.assert('runner').id!==id)throw new PcAccessDeniedError();return state;
    },
    launchApp:async(app,url)=>runGuarded('apps.launch',async signal=>createPcApplicationLauncher({authorizer,signal,resolve:options.launchResolve,spawnApp:options.launchSpawn}).launchPcApp(app,url)),
  };
}
export function registerPcTools(server:McpServer,deps:{authorizer:PcAuthorizer;host:PcHost;beforeRequest?:()=>void|Promise<void>;
  auditTool?:(record:{tool:string;at:number;outcome:'ok'|'error';code?:string})=>void|Promise<void>}){
  const a=deps.authorizer,h=deps.host,p=z.string().min(1).max(4096),jobId=z.string().uuid();
  const readOnly={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  const write={readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false};
  const audit=async(tool:string,outcome:'ok'|'error',code?:string)=>{
    try{await deps.auditTool?.({tool,at:Date.now(),outcome,...(code?{code}:{})});}catch{/* Audit I/O must not alter the tool result. */}
  };
  const run=async(action:()=>Promise<unknown>,status=false,tool='unknown')=>{
    try{await deps.beforeRequest?.();const data=await action();const value=status?{ok:true,...data as object}:{ok:true,data};await audit(tool,'ok');return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value};}
    catch(error){const code=error instanceof PcOperationError?error.code:error instanceof PcAccessDeniedError?'pc_access_denied':'pc_operation_failed';const value={ok:false,code};await audit(tool,'error',code);return {isError:true,content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value};}
  };
  const imageRun=async(action:()=>Promise<Uint8Array>,tool='unknown')=>{
    try{await deps.beforeRequest?.();const data=await action();const value={ok:true};
      await audit(tool,'ok');
      return {content:[{type:'image' as const,mimeType:'image/png',data:Buffer.from(data).toString('base64')}],structuredContent:value};
    }catch(error){const code=error instanceof PcOperationError?error.code:error instanceof PcAccessDeniedError?'pc_access_denied':'pc_operation_failed';
      const value={ok:false,code};await audit(tool,'error',code);return {isError:true,content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value};}
  };
  server.registerTool('pc_status',{title:'Feno PC status',description:'Read local approval and coordination status; never grants access.',inputSchema:z.object({}).strict(),annotations:readOnly},()=>run(async()=>({...a.status(),...await h.status()}),true,'pc_status'));
  server.registerTool('pc_list_files',{title:'List approved project files',inputSchema:z.object({path:p}).strict(),annotations:readOnly},({path})=>run(()=>{a.assert('files.read');return h.listFiles(path);},false,'pc_list_files'));
  server.registerTool('pc_read_file',{title:'Read approved UTF-8 file',description:'Bounded read within approved roots. Sensitive files are denied.',inputSchema:z.object({path:p}).strict(),annotations:readOnly},({path})=>run(()=>{a.assert('files.read');return h.readFile(path);},false,'pc_read_file'));
  server.registerTool('pc_write_patch',{title:'Patch approved file using SHA-256',description:'A SHA mismatch requires rereading the file and rebuilding the unified patch.',inputSchema:z.object({path:p,sha256:z.string().regex(/^[a-fA-F0-9]{64}$/),patch:z.string().min(1).max(256*1024)}).strict(),annotations:write},({path,sha256,patch})=>run(()=>{a.assert('files.write');return h.applyPatch(path,sha256,patch);},false,'pc_write_patch'));
  server.registerTool('pc_create_file',{title:'Create one new approved file',inputSchema:z.object({path:p,content:z.string().max(256*1024)}).strict(),annotations:write},({path,content})=>run(()=>{a.assert('files.write');return h.createFile(path,content);},false,'pc_create_file'));
  server.registerTool('pc_create_directory',{title:'Create one approved directory',inputSchema:z.object({path:p}).strict(),annotations:write},({path})=>run(()=>{a.assert('files.write');return h.createDirectory(path);},false,'pc_create_directory'));
  server.registerTool('pc_start_job',{title:'Start configured project job',description:'Project scripts run with the Windows account permissions; the project is not a sandbox.',inputSchema:z.object({kind:z.enum(['typecheck','unit-tests','android-build','playback-smoke']),projectRoot:p}).strict(),annotations:write},({kind,projectRoot})=>run(()=>{a.assert('jobs');return h.startJob(kind,projectRoot);},false,'pc_start_job'));
  server.registerTool('pc_list_project_tasks',{title:'List locally selected development tasks',inputSchema:z.object({projectRoot:p}).strict(),annotations:readOnly},({projectRoot})=>run(()=>{a.assert('jobs');return h.listProjectTasks(projectRoot);},false,'pc_list_project_tasks'));
  server.registerTool('pc_start_project_task',{title:'Start one configured development task',inputSchema:z.object({projectRoot:p,taskId:z.string().min(4).max(120).regex(/^(?:script:[a-zA-Z0-9:._-]+|android:[a-zA-Z]+|git:[a-z-]+)$/)}).strict(),annotations:write},({projectRoot,taskId})=>run(()=>{a.assert('jobs');return h.startProjectTask(projectRoot,taskId);},false,'pc_start_project_task'));
  server.registerTool('pc_start_terminal',{title:'Run explicitly approved Windows terminal',description:'Requires jobs AND terminal.exec. Runs with your Windows account permissions, outside project boundaries. One terminal per host; pc_terminal_busy means wait for completion.',inputSchema:z.object({projectRoot:p,command:z.string().min(1).max(2048).refine(v=>!v.includes('\0')),purpose:z.string().min(3).max(160)}).strict(),annotations:{...write,openWorldHint:true}},({projectRoot,command,purpose})=>run(()=>{a.assert('jobs');a.assert('terminal.exec');return h.startTerminal(projectRoot,command,purpose);},false,'pc_start_terminal'));
  server.registerTool('pc_job_status',{title:'Read owned project job state',inputSchema:z.object({jobId}).strict(),annotations:readOnly},({jobId})=>run(()=>{a.assert('jobs');return h.jobStatus(jobId);},false,'pc_job_status'));
  server.registerTool('pc_job_logs',{title:'Read bounded redacted job output',description:'Up to250 lines/64KiB per page; nextCursor and firstCursor identify retained output. Secrets matching known patterns are masked.',inputSchema:z.object({jobId,cursor:z.number().int().min(0).default(0)}).strict(),annotations:readOnly},({jobId,cursor})=>run(()=>{a.assert('jobs');return h.jobLogs(jobId,cursor);},false,'pc_job_logs'));
  server.registerTool('pc_cancel_job',{title:'Cancel owned job and descendants',inputSchema:z.object({jobId}).strict(),annotations:write},({jobId})=>run(()=>{a.assert('jobs');return h.cancelJob(jobId);},false,'pc_cancel_job'));
  const windowId=z.string().regex(/^[1-9][0-9]{0,15}$/),serial=z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
  server.registerTool('pc_runner_status',{title:'Read fenotip-tv runner state',inputSchema:z.object({label:z.literal('fenotip-tv')}).strict(),annotations:readOnly},()=>run(()=>{a.assert('runner');if(!h.runnerStatus)throw new PcAccessDeniedError();return h.runnerStatus();},false,'pc_runner_status'));
  server.registerTool('pc_list_windows',{title:'List approved Windows application windows',inputSchema:z.object({}).strict(),annotations:readOnly},()=>run(()=>{a.assert('screen.read');if(!h.listWindows)throw new PcAccessDeniedError();return h.listWindows();},false,'pc_list_windows'));
  server.registerTool('pc_capture_screen',{title:'Capture approved window PNG',inputSchema:z.object({windowId}).strict(),annotations:readOnly},({windowId:id})=>imageRun(async()=>{a.assert('screen.read');if(!h.captureScreen)throw new PcAccessDeniedError();return (await h.captureScreen(id)).data;},'pc_capture_screen'));
  server.registerTool('pc_capture_full_screen',{title:'Capture full desktop or one monitor PNG (high risk)',inputSchema:z.object({mode:z.enum(['all','monitor']),monitor:z.number().int().min(0).max(7).optional()}).strict(),annotations:readOnly},({mode,monitor})=>imageRun(async()=>{a.assert('screen.full');if(!h.captureFullScreen)throw new PcAccessDeniedError();return (await h.captureFullScreen(mode,monitor)).data;},'pc_capture_full_screen'));
  server.registerTool('pc_desktop_input',{title:'Control approved focused window',inputSchema:z.object({windowId,action:z.enum(['click','right_click','double_click','drag','scroll','key','type']),x:z.number().int().min(0).max(8192).optional(),y:z.number().int().min(0).max(8192).optional(),endX:z.number().int().min(0).max(8192).optional(),endY:z.number().int().min(0).max(8192).optional(),delta:z.number().int().min(-1080).max(1080).optional(),key:z.string().max(24).optional(),text:z.string().max(300).optional()}).strict(),annotations:write},input=>run(()=>{a.assert('desktop.input');if(!h.desktopInput)throw new PcAccessDeniedError();return h.desktopInput(input);},false,'pc_desktop_input'));
  server.registerTool('pc_adb_devices',{title:'List connected ADB devices',inputSchema:z.object({}).strict(),annotations:readOnly},()=>run(()=>{a.assert('adb');if(!h.adbDevices)throw new PcAccessDeniedError();return h.adbDevices();},false,'pc_adb_devices'));
  server.registerTool('pc_adb_input',{title:'Send emulator tap, key or text',inputSchema:z.object({serial,action:z.enum(['tap','key','text']),x:z.number().int().min(0).max(8192).optional(),y:z.number().int().min(0).max(8192).optional(),value:z.string().max(150).optional()}).strict(),annotations:write},({serial,...input})=>run(()=>{a.assert('adb');if(!h.adbInput)throw new PcAccessDeniedError();return h.adbInput(serial,input);},false,'pc_adb_input'));
  server.registerTool('pc_adb_screencap',{title:'Capture emulator PNG',inputSchema:z.object({serial}).strict(),annotations:readOnly},({serial})=>imageRun(async()=>{a.assert('adb');if(!h.adbScreencap)throw new PcAccessDeniedError();return h.adbScreencap(serial);},'pc_adb_screencap'));
  server.registerTool('pc_launch_app',{title:'Open locally approved application',inputSchema:z.object({app:z.string().min(1).max(4096),url:z.string().max(2048).optional()}).strict(),annotations:write},({app,url})=>run(()=>{a.assert('apps.launch');if(!h.launchApp)throw new PcAccessDeniedError();return h.launchApp(app,url);},false,'pc_launch_app'));
}
