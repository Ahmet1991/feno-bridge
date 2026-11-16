import {createHash} from 'node:crypto';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {PcAccessDeniedError,PcAuthorizer} from './authorization';
import {PcOperationError,invalidPcArgument} from './errors';
import {ProjectFileSession} from './project-file-native';

const MAX_TEXT=2*1024*1024,MAX_PATCH=256*1024;
const SENSITIVE_NAME=/^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|credentials(?:\.json)?|secrets?(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i;
const SENSITIVE_CONTENT=/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:authorization["']?\s*:\s*["']?bearer|(?:api[_-]?key|private[_-]?key|password|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?\S+)/i;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function safeName(file:string){if(typeof file!=='string')throw new PcAccessDeniedError();
  if(file.split(/[\\/]+/).some(s=>SENSITIVE_NAME.test(s)||s.toLowerCase()==='.git'))throw new PcOperationError('pc_sensitive_path');}
function text(bytes:Buffer):string{
  if(bytes.length>MAX_TEXT||bytes.includes(0))throw new PcAccessDeniedError();let value:string;
  try{value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new PcAccessDeniedError();}
  if(SENSITIVE_CONTENT.test(value))throw new PcOperationError('pc_sensitive_path');return value;
}
function encode(value:string):Buffer{
  if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>MAX_TEXT)throw new PcAccessDeniedError();
  const bytes=Buffer.from(value,'utf8');if(bytes.toString('utf8')!==value)throw new PcAccessDeniedError();text(bytes);return bytes;
}
function sameGrant(authorizer:PcAuthorizer,permission:'files.read'|'files.write',id:string){if(authorizer.assert(permission).id!==id)throw new PcAccessDeniedError();}
function operation<T>(run:()=>T):T{try{return run();}catch(e){if(e instanceof PcOperationError||e instanceof PcAccessDeniedError)throw e;throw new PcAccessDeniedError();}}
function session(file:string,roots:string[],kind:'file'|'directory'|'parent',patch=false,fullAccess=false):ProjectFileSession{
  safeName(file);try{const hold=new ProjectFileSession(file,roots,kind,patch,fullAccess);try{safeName(hold.path);return hold;}catch(e){hold.close();throw e;}}
  catch(e){
    // Only disclose absent leaves after the existing parent has passed confinement.
    if(kind==='file'&&[2,3].includes((e as {nativeCode?:number}).nativeCode??0)){
      const parent=new ProjectFileSession(file,roots,'parent',false,fullAccess);parent.close();throw new PcOperationError('pc_file_not_found');
    }throw e;
  }
}
export async function listPcFiles(root:string,relative:string,authorizer:PcAuthorizer,offset=0,limit=100){
  const grant=authorizer.assert('files.read');
  if(typeof relative!=='string'||relative.length>2048||path.win32.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw invalidPcArgument('path','Invalid relative directory');
  if(!Number.isSafeInteger(offset)||offset<0)throw invalidPcArgument('offset','Must be a nonnegative integer');
  if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw invalidPcArgument('limit','Must be between 1 and 200');
  return operation(()=>{const hold=session(path.win32.join(root,relative),grant.roots,'directory',false,grant.fullAccess);try{
    const entries=hold.list().filter(e=>!SENSITIVE_NAME.test(e.name)&&e.name.toLowerCase()!=='.git').sort((a,b)=>a.name.localeCompare(b.name));
    sameGrant(authorizer,'files.read',grant.id);
    return {entries:entries.slice(offset,offset+limit),pagination:{offset,limit,total:entries.length,nextOffset:offset+limit<entries.length?offset+limit:null},
      omitted:{sensitive:true,junctions:true}};
  }finally{hold.close();}});
}
export type PcReadOptions={offset?:number;length?:number;tailLines?:number};
/** Read image bytes through the same native path/junction checks as pc_read_file. */
export async function readPcImage(file:string,authorizer:PcAuthorizer):Promise<{
  mimeType:'image/png'|'image/jpeg'|'image/webp';data:Uint8Array
}>{
  const grant=authorizer.assert('files.read');
  const extension=path.extname(file).toLowerCase();
  const expected=extension==='.png'?'image/png':extension==='.jpg'||extension==='.jpeg'?'image/jpeg'
    :extension==='.webp'?'image/webp':undefined;
  if(!expected)throw invalidPcArgument('path','Only PNG, JPEG and WebP files are supported');
  return operation(()=>{
    const hold=session(file,grant.roots,'file',false,grant.fullAccess);
    try{
      const size=hold.size();if(size<12||size>8*1024*1024)throw new PcOperationError('pc_file_too_large',{limitBytes:8*1024*1024,sizeBytes:size});
      const bytes=hold.read();
      const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
      const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
      if(!(expected==='image/png'&&png||expected==='image/jpeg'&&jpeg||expected==='image/webp'&&webp))
        throw invalidPcArgument('path','Image extension and signature do not match');
      sameGrant(authorizer,'files.read',grant.id);
      return {mimeType:expected,data:bytes};
    }finally{hold.close();}
  });
}
export async function readPcFile(file:string,authorizer:PcAuthorizer,options:PcReadOptions={}):Promise<{path:string;content:string;sha256:string;sizeBytes?:number;offset?:number;nextOffset?:number;partial?:boolean}>{
  const grant=authorizer.assert('files.read');
  const {offset,length,tailLines}=options;
  if(tailLines!==undefined&&(offset!==undefined||length!==undefined))throw invalidPcArgument('tailLines','Cannot combine tailLines with offset or length');
  if(tailLines!==undefined&&(!Number.isSafeInteger(tailLines)||tailLines<1||tailLines>2000))throw invalidPcArgument('tailLines','Must be between 1 and 2000');
  if(offset!==undefined&&(!Number.isSafeInteger(offset)||offset<0))throw invalidPcArgument('offset','Must be a nonnegative integer');
  if(length!==undefined&&(!Number.isSafeInteger(length)||length<1||length>MAX_TEXT))throw invalidPcArgument('length','Must be between 1 and 2097152 bytes');
  return operation(()=>{const hold=session(file,grant.roots,'file',false,grant.fullAccess);try{
    const sizeBytes=hold.size();
    if(offset===undefined&&length===undefined&&tailLines===undefined&&sizeBytes>MAX_TEXT)
      throw new PcOperationError('pc_file_too_large',{limitBytes:MAX_TEXT,sizeBytes});
    const start=tailLines!==undefined?Math.max(0,sizeBytes-MAX_TEXT):offset??0;
    const bytes=hold.read(undefined,start,tailLines!==undefined?Math.min(sizeBytes-start,MAX_TEXT):offset!==undefined||length!==undefined?length??MAX_TEXT:undefined);
    let content=text(bytes);
    if(tailLines!==undefined){
      if(start>0){const firstBreak=content.indexOf('\n');content=firstBreak<0?'':content.slice(firstBreak+1);}
      content=content.split('\n').slice(-tailLines-(content.endsWith('\n')?1:0)).join('\n');
    }
    sameGrant(authorizer,'files.read',grant.id);
    return {path:hold.path,content,sha256:hash(bytes),...(offset!==undefined||length!==undefined||tailLines!==undefined?{sizeBytes,offset:start,nextOffset:start+bytes.length,partial:true}: {})};
  }finally{hold.close();}});
}
export async function createPcFile(file:string,content:string,authorizer:PcAuthorizer):Promise<{path:string;sha256:string}>{
  const grant=authorizer.assert('files.write');return operation(()=>{const bytes=encode(content),hold=session(file,grant.roots,'parent',false,grant.fullAccess);try{
    if(existsSync(hold.path))throw new PcOperationError('pc_file_exists');
    const stage=hold.stage(bytes);try{sameGrant(authorizer,'files.write',grant.id);
      try{stage.publish(false);}catch(error){if(existsSync(hold.path))throw new PcOperationError('pc_file_exists');throw error;}
      return {path:hold.path,sha256:hash(bytes)};}finally{stage.close();}}finally{hold.close();}});
}
export async function createPcDirectory(dir:string,authorizer:PcAuthorizer):Promise<{path:string}>{
  const grant=authorizer.assert('files.write');return operation(()=>{const hold=session(dir,grant.roots,'parent',false,grant.fullAccess);try{const stage=hold.stage(undefined);try{sameGrant(authorizer,'files.write',grant.id);stage.publish(false);return {path:hold.path};}finally{stage.close();}}finally{hold.close();}});
}

function patchText(original:string,patch:string):string{
  if(typeof patch!=='string'||Buffer.byteLength(patch,'utf8')>MAX_PATCH||patch.includes('\0'))throw new PcAccessDeniedError();
  const lines=(original.match(/[^\n]*\n|[^\n]+$/g)??[]).map(raw=>({text:raw.replace(/\r?\n$/,''),ending:raw.endsWith('\r\n')?'\r\n':raw.endsWith('\n')?'\n':''}));
  const preferred=original.match(/\r?\n/)?.[0]??'\n',finalNewline=original.length===0||original.endsWith('\n');
  const source=patch.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n'),out:typeof lines=[];
  let index=0,cursor=0,hunks=0;
  while(index<source.length){
    const match=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(source[index++]??'');
    if(!match||++hunks>100)throw new PcAccessDeniedError();
    const oldStart=Number(match[1]),oldCount=Number(match[2]??1),newStart=Number(match[3]),newCount=Number(match[4]??1),start=oldCount===0?oldStart:oldStart-1;
    if(![oldStart,oldCount,newStart,newCount].every(Number.isSafeInteger)||start<cursor||start>lines.length||newStart!==(newCount===0?out.length+start-cursor:out.length+start-cursor+1))throw new PcAccessDeniedError();
    out.push(...lines.slice(cursor,start));cursor=start;let removed=0,inserted=0;
    while(index<source.length&&!source[index]!.startsWith('@@ ')){
      const line=source[index++]!,mark=line[0],body=line.slice(1);
      if(mark===' '||mark==='-'){if(lines[cursor]?.text!==body)throw new PcAccessDeniedError();if(mark===' ')out.push(lines[cursor]!);cursor++;removed++;}
      if(mark===' '||mark==='+'){if(mark==='+')out.push({text:body,ending:preferred});inserted++;}
      if(mark!==' '&&mark!=='-'&&mark!=='+')throw new PcAccessDeniedError();
    }
    if(removed!==oldCount||inserted!==newCount)throw new PcAccessDeniedError();
  }
  if(!hunks)throw new PcAccessDeniedError();out.push(...lines.slice(cursor));
  return out.map((line,i)=>line.text+(i<out.length-1||finalNewline?line.ending||preferred:'')).join('');
}
/** Cooperating bridge calls are serialized. Ordinary Windows rename is not hostile-editor CAS. */
export async function applyPcPatch(file:string,expectedSha256:string,patch:string,authorizer:PcAuthorizer):Promise<{path:string;newSha256:string}>{
  const grant=authorizer.assert('files.write');
  if(typeof expectedSha256!=='string'||!(/^[a-f\d]{64}$/i.test(expectedSha256))||typeof patch!=='string')throw new PcAccessDeniedError();
  return operation(()=>{const hold=session(file,grant.roots,'file',true,grant.fullAccess);try{
    const original=hold.read(),previous=text(original);if(hash(original)!==expectedSha256.toLowerCase())throw new PcOperationError('pc_sha_mismatch');
    const bytes=encode(patchText(previous,patch)),stage=hold.stage(bytes);
    try{
      sameGrant(authorizer,'files.write',grant.id);hold.verifyLeaf();
      if(hash(hold.read())!==expectedSha256.toLowerCase())throw new PcOperationError('pc_sha_mismatch');
      stage.publish(true);return {path:hold.path,newSha256:hash(bytes)};
    }finally{stage.close();}
  }finally{hold.close();}});
}
