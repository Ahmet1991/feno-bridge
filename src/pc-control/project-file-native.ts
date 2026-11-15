import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {PcAccessDeniedError, isValidPcRoot} from './authorization';
import type {Pointer} from 'bun:ffi';

type Handle=bigint;
const MAX=2*1024*1024;
const deny=()=>new PcAccessDeniedError();
const wide=(value:string)=>Buffer.from(value+'\0','utf16le');
let backend:ReturnType<typeof load>|undefined;
function load(){
  if(process.platform!=='win32'||!process.versions.bun||process.arch!=='x64')throw deny();
  const {dlopen,ptr}=require('bun:ffi') as typeof import('bun:ffi');
  const system=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32');
  const k=dlopen(path.win32.join(system,'kernel32.dll'),{
    CreateFileW:{args:['ptr','u32','u32','ptr','u32','u32','ptr'],returns:'u64'},
    CloseHandle:{args:['u64'],returns:'bool'},GetLastError:{args:[],returns:'u32'},LocalFree:{args:['ptr'],returns:'ptr'},
    GetFileInformationByHandleEx:{args:['u64','u32','ptr','u32'],returns:'bool'},
    GetFinalPathNameByHandleW:{args:['u64','ptr','u32','u32'],returns:'u32'},
    GetFileSizeEx:{args:['u64','ptr'],returns:'bool'},SetFilePointerEx:{args:['u64','i64','ptr','u32'],returns:'bool'},
    ReadFile:{args:['u64','ptr','u32','ptr','ptr'],returns:'bool'},WriteFile:{args:['u64','ptr','u32','ptr','ptr'],returns:'bool'},
    SetEndOfFile:{args:['u64'],returns:'bool'},FlushFileBuffers:{args:['u64'],returns:'bool'},
    SetFileInformationByHandle:{args:['u64','u32','ptr','u32'],returns:'bool'},
    CreateMutexW:{args:['ptr','bool','ptr'],returns:'u64'},WaitForSingleObject:{args:['u64','u32'],returns:'u32'},ReleaseMutex:{args:['u64'],returns:'bool'},
  }).symbols;
  const a=dlopen(path.win32.join(system,'advapi32.dll'),{
    ConvertStringSecurityDescriptorToSecurityDescriptorW:{args:['ptr','u32','ptr','ptr'],returns:'bool'},
  }).symbols;
  const nt=dlopen(path.win32.join(system,'ntdll.dll'),{
    NtCreateFile:{args:['ptr','u32','ptr','ptr','ptr','u32','u32','u32','u32','ptr','u32'],returns:'i32'},
    NtSetInformationFile:{args:['u64','ptr','ptr','u32','u32'],returns:'i32'},
    RtlNtStatusToDosError:{args:['u32'],returns:'u32'},
  }).symbols;
  const sid:string=require('../../launcher/electron/private-acl-native.cjs').getCurrentUserSid();
  return {k,a,nt,ptr,sid};
}
function native(){return backend??=load();}
function checked(ok:unknown):void{if(!ok)throw Object.assign(deny(),{nativeCode:native().k.GetLastError()});}
function valid(input:string):string{
  if(typeof input!=='string'||input.length>4096||!(/^[a-z]:[\\/]/i.test(input))||input.includes('\0')||input.slice(2).includes(':')
    ||input.slice(3).split(/[\\/]/).some(s=>s==='..'||/[ .]$/.test(s)||/[<>"|?*\x00-\x1f]/.test(s)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))throw deny();
  return path.win32.normalize(input);
}
function within(file:string,root:string):boolean{const relative=path.win32.relative(root.toLowerCase(),file.toLowerCase());return relative===''||(!relative.startsWith('..\\')&&relative!=='..'&&!path.win32.isAbsolute(relative));}
function open(file:string,access:number,share=3,creation=3,security:Buffer|null=null):Handle{
  const {k}=native();const h=k.CreateFileW(wide(file),access>>>0,share,security,creation,0x02200000,null);
  if(h===0n||h===0xffffffffffffffffn)throw Object.assign(deny(),{nativeCode:k.GetLastError()});return h;
}
function ntChecked(status:number):void{if(status!==0)throw Object.assign(deny(),{nativeCode:native().nt.RtlNtStatusToDosError(status>>>0)});}
function child(parent:Handle,name:string,access:number,share:number,create:boolean,directory:boolean,security?:Buffer):Handle{
  if(!name||name==='.'||name==='..'||/[\\/:\0]/.test(name))throw deny();
  const {nt,ptr}=native(),bytes=Buffer.from(name,'utf16le'),unicode=Buffer.alloc(16),attributes=Buffer.alloc(48),out=Buffer.alloc(8),status=Buffer.alloc(16);
  unicode.writeUInt16LE(bytes.length);unicode.writeUInt16LE(bytes.length,2);unicode.writeBigUInt64LE(BigInt(ptr(bytes)),8);
  attributes.writeUInt32LE(48);attributes.writeBigUInt64LE(parent,8);attributes.writeBigUInt64LE(BigInt(ptr(unicode)),16);attributes.writeUInt32LE(0x40,24);
  if(security)attributes.writeBigUInt64LE(security.readBigUInt64LE(8),32);
  // A single component, relative to a pinned directory object. Reparse tags on
  // the leaf are opened rather than followed and then rejected by info().
  ntChecked(nt.NtCreateFile(out,(access|0x100000)>>>0,attributes,status,null,directory?0x10:0x80,share,create?2:1,(directory?1:0x40)|0x20|(create?0:0x200000),null,0));
  const h=out.readBigUInt64LE();if(!h||h===0xffffffffffffffffn)throw deny();
  if(create&&status.readBigUInt64LE(8)!==2n){native().k.CloseHandle(h);throw deny();}return h;
}
function info(h:Handle,directory:boolean):string{
  const {k}=native(),attributes=Buffer.alloc(8),standard=Buffer.alloc(24),id=Buffer.alloc(24);
  checked(k.GetFileInformationByHandleEx(h,9,attributes,8));
  if((attributes.readUInt32LE()&0x400)||!!(attributes.readUInt32LE()&0x10)!==directory)throw deny();
  checked(k.GetFileInformationByHandleEx(h,1,standard,24));
  if(standard[20]||(!directory&&standard.readUInt32LE(16)!==1))throw deny();
  checked(k.GetFileInformationByHandleEx(h,18,id,24));return id.toString('hex');
}
function finalPath(h:Handle):string{
  const buffer=Buffer.alloc(32768*2),n=native().k.GetFinalPathNameByHandleW(h,buffer,32768,0);
  if(!n||n>=32768)throw deny();const result=buffer.toString('utf16le',0,n*2);
  if(!result.startsWith('\\\\?\\')||result.startsWith('\\\\?\\UNC\\'))throw deny();return valid(result.slice(4));
}
function descriptor(directory:boolean){
  const {k,a,sid}=native(),out=Buffer.alloc(8),flags=directory?'OICI':'';
  checked(a.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(`O:${sid}D:P(A;${flags};FA;;;${sid})(A;${flags};FA;;;SY)(A;${flags};FA;;;BA)`),1,out,null));
  const address=Number(out.readBigUInt64LE());if(!Number.isSafeInteger(address)||!address)throw deny();
  const sa=Buffer.alloc(24);sa.writeUInt32LE(24);sa.writeBigUInt64LE(BigInt(address),8);return {sa,close:()=>k.LocalFree(address as Pointer)};
}

/** Windows handles, not POSIX modes, protect staging files. Project parent ACLs are not altered. */
export class ProjectFileSession {
  readonly path:string;
  readonly roots:string[]=[];
  private handles:Handle[]=[];
  private leaf:Handle|undefined;
  private parent:Handle|undefined;
  private mutex:Handle|undefined;
  private closed=false;
  constructor(requested:string,roots:string[],kind:'file'|'directory'|'parent',patch=false,fullAccess=false){
    this.path=valid(requested);
    try{
      if(!Array.isArray(roots)||roots.length===0)throw deny();
      const approvedIds=new Set<string>();
      for(const root of roots){if(!isValidPcRoot(root,fullAccess))throw deny();const h=this.chain(valid(root));this.roots.push(finalPath(h));approvedIds.add(info(h,true));}
      let approvedAncestor=false;
      const parent=path.win32.dirname(this.path),parentHandle=this.chain(kind==='directory'?this.path:parent,h=>{if(approvedIds.has(info(h,true)))approvedAncestor=true;});
      this.parent=parentHandle;
      const actualParent=finalPath(parentHandle);
      const canonical=kind==='directory'?actualParent:path.win32.join(actualParent,path.win32.basename(this.path));
      // Compare actual directory identities too: NTFS can enable case-sensitive
      // names, so case-folded textual containment alone is not sufficient.
      if(!approvedAncestor||!this.roots.some(root=>within(canonical,root)))throw deny();
      this.path=canonical;
      // Serialize cooperating processes across both profiles. No wait blocks the JS thread.
      if(kind==='parent'||patch){
        const policy=descriptor(false);try{this.mutex=native().k.CreateMutexW(policy.sa,false,wide('Local\\FenoPcFile-'+createHash('sha256').update(this.path.toLowerCase()).digest('hex')));}finally{policy.close();}
        if(!this.mutex)throw deny();const result=native().k.WaitForSingleObject(this.mutex,0);
        if(result!==0&&result!==0x80)throw deny();
      }
      if(kind==='file'){
        // Atomic rename requires share-delete on the old leaf. Never allow shared data writes.
        this.leaf=child(this.parent!,path.win32.basename(this.path),0x80020080,patch?5:1,false,false);this.handles.push(this.leaf);info(this.leaf,false);
        if(finalPath(this.leaf).toLowerCase()!==this.path.toLowerCase())throw deny();
      }else if(kind==='directory')this.leaf=parentHandle;
    }catch(e){this.close();throw e;}
  }
  private chain(directory:string,visit?:(h:Handle)=>void):Handle{
    const parts:string[]=[];for(let current=directory;;current=path.win32.dirname(current)){parts.unshift(current);if(path.win32.dirname(current)===current)break;}
    let last:Handle|undefined;
    // No ancestor permits delete sharing. Each subsequent component is opened
    // relative to the preceding handle, so retagging an empty ancestor cannot
    // redirect a later pathname-based data open.
    for(const item of parts){last=last?child(last,path.win32.basename(item),0x20081,3,false,true):open(item,0x20081);this.handles.push(last);info(last,true);visit?.(last);}
    return last!;
  }
  read(h=this.leaf):Buffer{
    if(!h||this.closed)throw deny();info(h,false);
    const {k}=native(),size=Buffer.alloc(8);checked(k.GetFileSizeEx(h,size));const n=Number(size.readBigInt64LE());
    if(!Number.isSafeInteger(n)||n<0||n>MAX)throw deny();checked(k.SetFilePointerEx(h,0,null,0));
    const bytes=Buffer.alloc(n);let offset=0;
    while(offset<n){const count=Buffer.alloc(4);checked(k.ReadFile(h,bytes.subarray(offset),n-offset,count,null));const got=count.readUInt32LE();if(!got)throw deny();offset+=got;}
    info(h,false);return bytes;
  }
  verifyLeaf():void{
    if(!this.leaf)throw deny();
    const expected=info(this.leaf,false),current=child(this.parent!,path.win32.basename(this.path),0x20080,5,false,false);
    try{if(info(current,false)!==expected||finalPath(this.leaf).toLowerCase()!==this.path.toLowerCase())throw deny();}finally{native().k.CloseHandle(current);}
  }
  list():{name:string;kind:'file'|'directory'}[]{
    if(!this.leaf)throw deny();const {k}=native(),buffer=Buffer.alloc(65536),result:{name:string;kind:'file'|'directory'}[]=[];
    let first=true,count=0;
    for(;;){
      if(!k.GetFileInformationByHandleEx(this.leaf,first?11:10,buffer,buffer.length)){if(k.GetLastError()===18)break;throw deny();}first=false;
      let offset=0;
      for(;;){
        if(offset+104>buffer.length)throw deny();const next=buffer.readUInt32LE(offset),attrs=buffer.readUInt32LE(offset+56),length=buffer.readUInt32LE(offset+60);
        if(length%2||offset+104+length>buffer.length)throw deny();const name=buffer.toString('utf16le',offset+104,offset+104+length);
        if(name!=='.'&&name!=='..'){
          if(++count>500)throw deny();
          if(!(attrs&0x400)){
            let child:Handle|undefined;
            try{child=this.openEntry(name,!!(attrs&0x10));info(child,!!(attrs&0x10));result.push({name,kind:attrs&0x10?'directory':'file'});}catch{/* uninspectable aliases are not disclosed */}finally{if(child)k.CloseHandle(child);}
          }
        }
        if(!next)break;if(next<104||offset+next<=offset)throw deny();offset+=next;
      }
    }
    return result;
  }
  private openEntry(name:string,directory:boolean):Handle{return child(this.leaf!,name,0x20080,1,false,directory);}
  stage(bytes:Buffer|undefined):{handle:Handle;publish(replace:boolean):void;close():void}{
    const directory=bytes===undefined,{k}=native(),temp=path.win32.join(path.win32.dirname(this.path),`.feno-pc-${randomUUID()}.tmp`);
    let h:Handle|undefined,published=false;
    const policy=descriptor(directory);
    try{
      // FILE_CREATE atomically returns the new file/directory handle. A private
      // descriptor is applied at birth; there is no create-then-open window.
      h=child(this.parent!,path.win32.basename(temp),directory?0x30081:0xc0030080,1,true,directory,policy.sa);
      info(h,directory);
      if(bytes){
        let offset=0;while(offset<bytes.length){const count=Buffer.alloc(4);checked(k.WriteFile(h,bytes.subarray(offset),bytes.length-offset,count,null));const n=count.readUInt32LE();if(!n)throw deny();offset+=n;}
        checked(k.SetEndOfFile(h));checked(k.FlushFileBuffers(h));if(!this.read(h).equals(bytes))throw deny();
      }
    }catch(e){if(h){this.remove(h);k.CloseHandle(h);}throw e;}finally{policy.close();}
    const handle=h;
    return {handle,publish:(replace:boolean)=>{
      const name=Buffer.from(path.win32.basename(this.path),'utf16le'),rename=Buffer.alloc(20+name.length+2);rename.writeUInt32LE(replace?3:0);rename.writeBigUInt64LE(this.parent!,8);rename.writeUInt32LE(name.length,16);name.copy(rename,20);
      // Native rename resolves a single name through the pinned parent handle.
      // REPLACE_IF_EXISTS|POSIX_SEMANTICS retains the old read handle through
      // replacement. This is the ordinary access-checked class, never a
      // BypassAccessCheck variant. Unsupported filesystems fail closed.
      ntChecked(native().nt.NtSetInformationFile(handle,Buffer.alloc(16),rename,rename.length,replace?65:10));published=true;
      if(finalPath(handle).toLowerCase()!==this.path.toLowerCase())throw deny();info(handle,directory);
      if(bytes&&!this.read(handle).equals(bytes))throw deny();
    },close:()=>{if(!published)this.remove(handle);k.CloseHandle(handle);}};
  }
  private remove(h:Handle):void{const disposition=Buffer.alloc(4);disposition.writeUInt32LE(1);native().k.SetFileInformationByHandle(h,4,disposition,4);}
  close():void{
    if(this.closed)return;this.closed=true;const {k}=native();
    for(const h of this.handles.reverse())k.CloseHandle(h);this.handles=[];
    if(this.mutex){k.ReleaseMutex(this.mutex);k.CloseHandle(this.mutex);this.mutex=undefined;}
  }
}
