import path from 'node:path';
import type {PcCommandSpec} from './jobs';

/** Windows x64 ABI. Jobs stay contained; approved GUI-only terminal commands may let detached children escape. */
function native() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !process.versions.bun) throw new Error('pc_job_containment_required');
  const {dlopen, ptr} = require('bun:ffi') as typeof import('bun:ffi');
  const library = dlopen(path.win32.join(process.env.SystemRoot || 'C:\\Windows','System32','kernel32.dll'), {
    CreateJobObjectW:{args:['ptr','ptr'],returns:'u64'},
    SetInformationJobObject:{args:['u64','u32','ptr','u32'],returns:'bool'},
    QueryInformationJobObject:{args:['u64','u32','ptr','u32','ptr'],returns:'bool'},
    TerminateJobObject:{args:['u64','u32'],returns:'bool'},
    InitializeProcThreadAttributeList:{args:['ptr','u32','u32','ptr'],returns:'bool'},
    UpdateProcThreadAttribute:{args:['ptr','u32','u64','ptr','u64','ptr','ptr'],returns:'bool'},
    DeleteProcThreadAttributeList:{args:['ptr'],returns:'void'},
    CreateProcessW:{args:['ptr','ptr','ptr','ptr','bool','u32','ptr','ptr','ptr','ptr'],returns:'bool'},
    CreatePipe:{args:['ptr','ptr','ptr','u32'],returns:'bool'},
    PeekNamedPipe:{args:['u64','ptr','u32','ptr','ptr','ptr'],returns:'bool'},
    ReadFile:{args:['u64','ptr','u32','ptr','ptr'],returns:'bool'},
    SetHandleInformation:{args:['u64','u32','u32'],returns:'bool'},
    CreateFileW:{args:['ptr','u32','u32','ptr','u32','u32','u64'],returns:'u64'},
    SearchPathW:{args:['ptr','ptr','ptr','u32','ptr','ptr'],returns:'u32'},
    GetExitCodeProcess:{args:['u64','ptr'],returns:'bool'},
    CloseHandle:{args:['u64'],returns:'bool'},GetLastError:{args:[],returns:'u32'},
  });
  return {k:library.symbols,ptr};
}
let api:ReturnType<typeof native>|undefined;
const wide=(s:string)=>Buffer.from(s+'\0','utf16le');
const invalid=0xffffffffffffffffn;
type Handle=number|bigint;

export interface PcContainedProcess {
  readonly pid:number;
  /** Resolves only after QueryInformationJobObject observes ActiveProcesses == 0. */
  readonly exited:Promise<{exitCode:number}>;
  terminate(exitCode?:number):void;
}

/** CommandLineToArgvW/MS CRT quoting (the application name is supplied separately). */
function quote(argument:string):string {
  return '"'+argument.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\*)$/,'$1$1')+'"';
}

export function spawnContainedWindowsProcess(spec:PcCommandSpec,cwd:string,
  stdout:(bytes:Buffer)=>void,stderr:(bytes:Buffer)=>void):PcContainedProcess {
  const {k,ptr}=api??=native();
  function checked(ok:unknown,operation:string):void {
    if(!ok)throw Object.assign(new Error('pc_job_containment_failed'),{code:'pc_job_containment_failed',operation,nativeCode:k.GetLastError()});
  }
  const close=(h:Handle)=>{if(BigInt(h)!==0n&&BigInt(h)!==invalid)k.CloseHandle(h);};
  if(typeof spec.command!=='string'||!spec.command||spec.command.includes('\0')||!Array.isArray(spec.args)
    ||spec.args.some(a=>typeof a!=='string'||a.includes('\0'))||!path.win32.isAbsolute(cwd))throw new Error('pc_job_containment_failed');
  let executable=spec.command;
  if(!path.win32.isAbsolute(executable)){
    // Search once, then give CreateProcess the absolute application path. No shell resolution.
    const found=Buffer.alloc(65536);
    const count=k.SearchPathW(null,wide(executable),wide('.exe'),32768,found,null);
    checked(count>0&&count<32768,'SearchPathW');executable=found.subarray(0,count*2).toString('utf16le');
  }
  const command=wide([executable,...spec.args].map(quote).join(' '));
  if(command.length>65534)throw new Error('pc_job_containment_failed');
  const job=k.CreateJobObjectW(null,null);checked(job,'CreateJobObjectW');
  const handles:Handle[]=[job],attributeValues:Buffer[]=[];let attributes:Buffer|undefined,attributesReady=false;
  let outputRead:Handle=0,errorRead:Handle=0,outputWrite:Handle=0,errorWrite:Handle=0,input:Handle=0;
  const info=Buffer.alloc(24);
  try {
    checked(k.SetHandleInformation(job,1,0),'noninheritable job');
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes); BasicLimitInformation.Flags at 16.
    const limits=Buffer.alloc(144);
    // SILENT_BREAKAWAY_OK is restricted to a single full-access GUI launch.
    // The enclosing shell remains in this job; ordinary jobs retain kill-on-close.
    limits.writeUInt32LE(0x2000 | (spec.allowGuiBreakaway===true?0x1000:0),16);
    checked(k.SetInformationJobObject(job,9,limits,limits.length),'SetInformationJobObject');
    const security=Buffer.alloc(24);security.writeUInt32LE(24);security.writeUInt32LE(1,16);
    function pipe():[Handle,Handle]{
      const read=Buffer.alloc(8),write=Buffer.alloc(8);
      checked(k.CreatePipe(read,write,security,0),'CreatePipe');
      const r=read.readBigUInt64LE(),w=write.readBigUInt64LE();handles.push(r,w);
      checked(k.SetHandleInformation(r,1,0),'noninheritable reader');return [r,w];
    }
    [outputRead,outputWrite]=pipe();[errorRead,errorWrite]=pipe();
    input=k.CreateFileW(wide(spec.stdinFile??'NUL'),0x80000000,3,security,3,0x80,0);
    checked(BigInt(input)!==invalid&&BigInt(input)!==0n,'CreateFileW stdin');handles.push(input);
    const size=Buffer.alloc(8);k.InitializeProcThreadAttributeList(null,2,0,size);
    const length=Number(size.readBigUInt64LE());checked(length>0&&length<=65536,'attribute size');
    attributes=Buffer.alloc(length);checked(k.InitializeProcThreadAttributeList(attributes,2,0,size),'InitializeProcThreadAttributeList');attributesReady=true;
    const jobs=Buffer.alloc(8);jobs.writeBigUInt64LE(BigInt(job));
    attributeValues.push(jobs);
    checked(k.UpdateProcThreadAttribute(attributes,0,0x2000d,jobs,8,null,null),'JOB_LIST');
    const inherited=Buffer.alloc(24);[input,outputWrite,errorWrite].forEach((h,i)=>inherited.writeBigUInt64LE(BigInt(h),i*8));
    attributeValues.push(inherited);
    checked(k.UpdateProcThreadAttribute(attributes,0,0x20002,inherited,24,null,null),'HANDLE_LIST');
    // STARTUPINFOEXW: STARTUPINFOW=104 bytes, attribute pointer at 104, total=112.
    // https://learn.microsoft.com/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow
    const startup=Buffer.alloc(112);startup.writeUInt32LE(112);startup.writeUInt32LE(0x100,60);
    startup.writeBigUInt64LE(BigInt(input),80);startup.writeBigUInt64LE(BigInt(outputWrite),88);startup.writeBigUInt64LE(BigInt(errorWrite),96);
    startup.writeBigUInt64LE(BigInt(ptr(attributes)),104);
    checked(k.CreateProcessW(wide(executable),command,null,null,true,0x08080000,null,wide(cwd),startup,info),'CreateProcessW');
  } catch(error) {
    // Every throwing operation precedes successful CreateProcess: there is no child on this path.
    for(const h of handles)close(h);throw error;
  } finally {
    if(attributesReady)k.DeleteProcThreadAttributeList(attributes!);
    // UpdateProcThreadAttribute retains pointers, not copies. Keep both backing
    // buffers reachable through CreateProcess and attribute-list destruction.
    attributeValues.length=0;
  }
  const processHandle=info.readBigUInt64LE(),thread=info.readBigUInt64LE(8),pid=info.readUInt32LE(16);
  close(thread);close(outputWrite);close(errorWrite);close(input);
  let closed=false;
  const terminate=(code=1)=>{if(!closed)checked(k.TerminateJobObject(job,code>>>0),'TerminateJobObject');};
  const exited=new Promise<{exitCode:number}>((resolve,reject)=>{
    const available=Buffer.alloc(4),count=Buffer.alloc(4),chunk=Buffer.alloc(65536),accounting=Buffer.alloc(48),code=Buffer.alloc(4);
    function drain(handle:Handle,receive:(bytes:Buffer)=>void){
      for(let i=0;i<16;i++){
        if(!k.PeekNamedPipe(handle,null,0,null,available,null)){
          if([109,232].includes(k.GetLastError()))return;checked(false,'PeekNamedPipe');
        }
        const n=Math.min(chunk.length,available.readUInt32LE());if(!n)return;
        checked(k.ReadFile(handle,chunk,n,count,null),'ReadFile');const got=count.readUInt32LE();if(!got)return;
        receive(Buffer.from(chunk.subarray(0,got)));
      }
    }
    const tick=()=>{
      try {
        drain(outputRead,stdout);drain(errorRead,stderr);
        checked(k.QueryInformationJobObject(job,1,accounting,48,null),'QueryInformationJobObject');
        // Four LARGE_INTEGERs + two DWORDs precede ActiveProcesses (offset 40).
        if(accounting.readUInt32LE(40)!==0)return;
        drain(outputRead,stdout);drain(errorRead,stderr);
        checked(k.GetExitCodeProcess(processHandle,code),'GetExitCodeProcess');
        closed=true;clearInterval(timer);close(outputRead);close(errorRead);close(processHandle);close(job);
        resolve({exitCode:code.readUInt32LE()});
      } catch(error) {
        clearInterval(timer);
        // Unknown completion cannot release a host lease. Keep the job handle until owner exit.
        try{terminate();}catch{/* retain containment and report the original observation failure */}
        reject(error);
      }
    };
    const timer=setInterval(tick,10);
  });
  return {pid,exited,terminate};
}
