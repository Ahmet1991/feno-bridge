import {createHash} from 'node:crypto';
import path from 'node:path';
import {PcAccessDeniedError,PcAuthorizer} from './authorization';
import {PcOperationError} from './errors';
import {ProjectFileSession} from './project-file-native';

const MAX_TEXT=2*1024*1024,MAX_PATCH=256*1024;
const SENSITIVE_NAME=/^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|credentials(?:\.json)?|secrets?(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i;
const SENSITIVE_CONTENT=/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:authorization["']?\s*:\s*["']?bearer|(?:api[_-]?key|private[_-]?key|password|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?\S+)/i;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function safeName(file:string){if(typeof file!=='string'||file.split(/[\\/]+/).some(s=>SENSITIVE_NAME.test(s)||s.toLowerCase()==='.git'))throw new PcAccessDeniedError();}
function text(bytes:Buffer):string{
  if(bytes.length>MAX_TEXT||bytes.includes(0))throw new PcAccessDeniedError();let value:string;
  try{value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new PcAccessDeniedError();}
  if(SENSITIVE_CONTENT.test(value))throw new PcAccessDeniedError();return value;
}
function encode(value:string):Buffer{
  if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>MAX_TEXT)throw new PcAccessDeniedError();
  const bytes=Buffer.from(value,'utf8');if(bytes.toString('utf8')!==value)throw new PcAccessDeniedError();text(bytes);return bytes;
}
function sameGrant(authorizer:PcAuthorizer,permission:'files.read'|'files.write',id:string){if(authorizer.assert(permission).id!==id)throw new PcAccessDeniedError();}
function operation<T>(run:()=>T):T{try{return run();}catch(e){if(e instanceof PcOperationError||e instanceof PcAccessDeniedError)throw e;throw new PcAccessDeniedError();}}
function session(file:string,roots:string[],kind:'file'|'directory'|'parent',patch=false):ProjectFileSession{
  safeName(file);try{const hold=new ProjectFileSession(file,roots,kind,patch);try{safeName(hold.path);return hold;}catch(e){hold.close();throw e;}}
  catch(e){
    // Only disclose absent leaves after the existing parent has passed confinement.
    if(kind==='file'&&[2,3].includes((e as {nativeCode?:number}).nativeCode??0)){
      const parent=new ProjectFileSession(file,roots,'parent');parent.close();throw new PcOperationError('pc_file_not_found');
    }throw e;
  }
}
export async function listPcFiles(root:string,relative:string,authorizer:PcAuthorizer):Promise<{name:string;kind:'file'|'directory'}[]>{
  const grant=authorizer.assert('files.read');
  if(typeof relative!=='string'||relative.length>2048||path.win32.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw new PcAccessDeniedError();
  return operation(()=>{const hold=session(path.win32.join(root,relative),grant.roots,'directory');try{const entries=hold.list().filter(e=>!SENSITIVE_NAME.test(e.name)&&e.name.toLowerCase()!=='.git');sameGrant(authorizer,'files.read',grant.id);return entries;}finally{hold.close();}});
}
export async function readPcFile(file:string,authorizer:PcAuthorizer):Promise<{path:string;content:string;sha256:string}>{
  const grant=authorizer.assert('files.read');return operation(()=>{const hold=session(file,grant.roots,'file');try{const bytes=hold.read(),content=text(bytes);sameGrant(authorizer,'files.read',grant.id);return {path:hold.path,content,sha256:hash(bytes)};}finally{hold.close();}});
}
export async function createPcFile(file:string,content:string,authorizer:PcAuthorizer):Promise<{path:string;sha256:string}>{
  const grant=authorizer.assert('files.write');return operation(()=>{const bytes=encode(content),hold=session(file,grant.roots,'parent');try{const stage=hold.stage(bytes);try{sameGrant(authorizer,'files.write',grant.id);stage.publish(false);return {path:hold.path,sha256:hash(bytes)};}finally{stage.close();}}finally{hold.close();}});
}
export async function createPcDirectory(dir:string,authorizer:PcAuthorizer):Promise<{path:string}>{
  const grant=authorizer.assert('files.write');return operation(()=>{const hold=session(dir,grant.roots,'parent');try{const stage=hold.stage(undefined);try{sameGrant(authorizer,'files.write',grant.id);stage.publish(false);return {path:hold.path};}finally{stage.close();}}finally{hold.close();}});
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
  return operation(()=>{const hold=session(file,grant.roots,'file',true);try{
    const original=hold.read(),previous=text(original);if(hash(original)!==expectedSha256.toLowerCase())throw new PcOperationError('pc_sha_mismatch');
    const bytes=encode(patchText(previous,patch)),stage=hold.stage(bytes);
    try{
      sameGrant(authorizer,'files.write',grant.id);hold.verifyLeaf();
      if(hash(hold.read())!==expectedSha256.toLowerCase())throw new PcOperationError('pc_sha_mismatch');
      stage.publish(true);return {path:hold.path,newSha256:hash(bytes)};
    }finally{stage.close();}
  }finally{hold.close();}});
}
