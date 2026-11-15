import {lstatSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {PcAccessDeniedError,isValidPcRoot} from './authorization';
const p=process.platform==='win32'?path.win32:path.posix;
const canonical=(value:string)=>{try{return realpathSync.native(value);}catch{throw new PcAccessDeniedError();}};
function within(candidate:string,root:string){
  const fold=(s:string)=>process.platform==='win32'?s.toLowerCase():s;
  const relative=p.relative(fold(root),fold(candidate));
  return relative===''||(relative!=='..'&&!relative.startsWith('..'+p.sep)&&!p.isAbsolute(relative));
}
/** A path boundary primitive, not a file read/write or MCP tool. */
export function resolveAllowedPath(requested:string,roots:string[],options:{forCreate?:boolean;fullAccess?:boolean}={}):string {
  if(typeof requested!=='string'||requested.length>4096||requested.includes('\0')||!p.isAbsolute(requested)
    ||(process.platform==='win32'&&(!/^[a-z]:[\\/]/i.test(requested)||requested.slice(2).includes(':')))
    ||!Array.isArray(roots)||!roots.length)throw new PcAccessDeniedError();
  const accepted=roots.map(root=>{if(!isValidPcRoot(root,options.fullAccess===true)||!p.isAbsolute(root))throw new PcAccessDeniedError();const actual=canonical(root);if(!statSync(actual).isDirectory())throw new PcAccessDeniedError();return actual;});
  const normalized=p.normalize(requested);
  let actual:string;
  if(options.forCreate){
    actual=p.join(canonical(p.dirname(normalized)),p.basename(normalized));
    try{if(lstatSync(actual).isSymbolicLink())throw new PcAccessDeniedError();}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new PcAccessDeniedError();}
  }else actual=canonical(normalized);
  if(!accepted.some(root=>within(actual,root)))throw new PcAccessDeniedError();return actual;
}
