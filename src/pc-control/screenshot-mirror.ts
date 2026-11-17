import {readdirSync,statSync,writeFileSync,unlinkSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import sharp from 'sharp';
import {PcAccessDeniedError,type PcAuthorizer} from './authorization';
import {resolveAllowedPath} from './paths';
import type {PcScreenshotSource} from './screenshot-widget';

export async function mirrorPcScreenshot(directory:string|undefined,source:PcScreenshotSource,authorizer:PcAuthorizer):Promise<{mirrorPath?:string;mirrorError?:string}>{
  if(!directory)return {};
  try{
    const grant=authorizer.assert('files.write');
    const options={fullAccess:grant.fullAccess};
    const folder=resolveAllowedPath(directory,grant.roots,options);
    if(!statSync(folder).isDirectory())throw new PcAccessDeniedError();
    const png=source.mimeType==='image/png'?Buffer.from(source.data):await sharp(source.data,{limitInputPixels:100_000_000}).png().toBuffer();
    if(authorizer.assert('files.write').id!==grant.id)throw new PcAccessDeniedError();
    const stamp=new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
    const title=source.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').replace(/[ .]+$/g,'').slice(0,60)||'Ekran';
    let target='';
    for(let i=0;i<100;i++){
      target=resolveAllowedPath(join(folder,`PC2-${stamp}-${title}${i?'-'+i:''}.png`),grant.roots,{...options,forCreate:true});
      try{writeFileSync(target,png,{flag:'wx'});break;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||i===99)throw error;}
    }
    const entries=readdirSync(folder,{withFileTypes:true}).filter(e=>e.isFile()&&/^PC2-\d{8}-\d{6}-.+\.png$/.test(e.name))
      .map(e=>({path:join(folder,e.name),time:lstatSync(join(folder,e.name)).mtimeMs}))
      .sort((a,b)=>b.time-a.time);
    for(const entry of entries.filter(e=>e.path!==target).slice(49)){
      if(authorizer.assert('files.write').id!==grant.id)throw new PcAccessDeniedError();
      const file=resolveAllowedPath(entry.path,grant.roots,options);
      if(!lstatSync(entry.path).isSymbolicLink()&&file===entry.path)unlinkSync(file);
    }
    return {mirrorPath:target};
  }catch(error){return {mirrorError:error instanceof PcAccessDeniedError?'pc_access_denied':'pc_mirror_failed'};}
}
