import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PcAccessDeniedError, PcAuthorizer } from './authorization';
import { PcOperationError, invalidPcArgument } from './errors';
import {resolveAllowedPath} from './paths';
import {invokePackagedWindowsHelper,pcWindowsHelperStatus,type PcWindowsHelper} from './windows';

export const PC_LAUNCHABLE_APPS = ['notepad.exe', 'chrome.exe', 'msedge.exe'] as const;
export type PcLaunchableApp = string;

export function normalizePcLaunchApp(app: unknown): string {
  if(typeof app!=='string'||!app.length||app.length>4096)throw invalidPcArgument('app','Expected a valid executable name');
  const lower=app.toLowerCase();
  for(const name of PC_LAUNCHABLE_APPS){
    if(lower===name||lower===name.slice(0,-4))return name;
  }
  // Other installed executables may be launched in full access, but must be explicit.
  if(!lower.endsWith('.exe'))throw invalidPcArgument('app','Unknown application alias',PC_LAUNCHABLE_APPS);
  if(!(/^[a-zA-Z0-9_ .()-]+\.exe$/i.test(app)||/^[a-z]:\\[^\x00-\x1f"<>|?*]+\.exe$/i.test(app)))
    throw invalidPcArgument('app','Invalid executable path');
  return app;
}

export function resolveTrustedPcApplication(app: PcLaunchableApp, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const system = environment.SystemRoot || 'C:\\Windows';
  const programFiles = environment.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = app === 'notepad.exe'
    ? [join(system, 'System32', 'notepad.exe')]
    : app === 'chrome.exe'
      ? [join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')]
      : app === 'msedge.exe'
        ? [join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
        : [];
  for (const candidate of candidates) {
    try {
      if (!win32.isAbsolute(candidate) || !existsSync(candidate) || !statSync(candidate).isFile()) continue;
      if (realpathSync.native(candidate).toLowerCase() !== candidate.toLowerCase()) continue;
      return candidate;
    } catch { /* An absent or redirected application is not launchable. */ }
  }
  return undefined;
}

function resolveFullPcApplication(app:string, environment:NodeJS.ProcessEnv=process.env):string|undefined {
  if(typeof app!=='string'||app.length>4096||!app.toLowerCase().endsWith('.exe')||/[\x00-\x1f"<>|?*]/.test(app))return undefined;
  const absolute=win32.isAbsolute(app)&&/^[a-z]:\\/i.test(app)&&!app.slice(3).includes(':');
  if(!absolute&&!/^[a-zA-Z0-9_ .()-]+\.exe$/i.test(app))return undefined;
  const pathEntries=(environment.Path||environment.PATH||'').split(';').filter(Boolean);
  const candidates=absolute?[app]:[
    ...(PC_LAUNCHABLE_APPS.includes(app as typeof PC_LAUNCHABLE_APPS[number])?[resolveTrustedPcApplication(app,environment)]:[]),
    join(environment.SystemRoot||'C:\\Windows','System32',app),
    join(environment.SystemRoot||'C:\\Windows',app),
    ...pathEntries.map(entry=>join(entry,app)),
  ];
  for(const candidate of candidates){
    if(!candidate)continue;
    try{if(win32.isAbsolute(candidate)&&statSync(candidate).isFile()&&realpathSync.native(candidate).toLowerCase()===win32.normalize(candidate).toLowerCase())return candidate;}catch{}
  }
  return undefined;
}

export function validatePcLaunchUrl(raw: unknown,roots:string[]=[],fullAccess=false): string {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 2048 || /[\s\x00-\x1f\x7f]/.test(raw)) throw invalidPcArgument('url','Expected a valid URL');
  let url: URL;
  try { url = new URL(raw); } catch { throw invalidPcArgument('url','Invalid URL'); }
  if(url.protocol==='file:'){
    if(!fullAccess||!/^file:\/\/\/[a-z]:\//i.test(raw)||url.hostname||url.username||url.password
      ||url.search||url.hash||url.href!==raw||raw.includes('\\'))
      throw invalidPcArgument('url','Only canonical local file URLs inside approved roots are accepted');
    try{
      const requested=fileURLToPath(url);
      // Reject junctions/symlinks even when their resolved destination is inside a permitted drive.
      let current=win32.parse(requested).root;
      for(const part of requested.slice(current.length).split('\\').filter(Boolean)){
        current=win32.join(current,part);
        if(lstatSync(current).isSymbolicLink())throw Error('reparse point');
      }
      const permitted=resolveAllowedPath(requested,roots,{fullAccess:true});
      if(!statSync(permitted).isFile())throw Error('not a regular file');
    }catch{throw invalidPcArgument('url','Local file does not resolve to a regular file inside approved roots');}
    return url.href;
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.href !== raw || raw.includes('\\')) throw invalidPcArgument('url','Only canonical HTTP(S) URLs without credentials are accepted');
  return url.href;
}

export function createPcApplicationLauncher(options: {
  authorizer: PcAuthorizer;
  resolve?: (app: PcLaunchableApp) => string | undefined;
  spawnApp?: (executable: string, args: string[]) => void | number | Promise<void | number>;
  windowHelper?: PcWindowsHelper;
  signal?: AbortSignal;
}) {
  const resolve = options.resolve ?? resolveTrustedPcApplication;
  const spawnApp = options.spawnApp ?? ((executable: string, args: string[]) => new Promise<number | undefined>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new PcAccessDeniedError()); return; }
    const child = spawn(executable, args, { shell: false, windowsHide: false, detached: true, stdio: 'ignore' });
    let settled = false;
    const abort = () => { child.kill(); if (!settled) { settled = true; reject(new PcAccessDeniedError()); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => {
      options.signal?.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(error); }
    });
    child.once('spawn', () => {
      options.signal?.removeEventListener('abort', abort);
      if (settled) return;
      if (options.signal?.aborted) { abort(); return; }
      settled = true;
      child.unref();
      resolve(child.pid);
    });
  }));
  const windowHelper=options.windowHelper??(pcWindowsHelperStatus().available?invokePackagedWindowsHelper:undefined);
  type LaunchWindow={id:string;title:string;processName:string;processId?:number};
  async function listed(app:string):Promise<LaunchWindow[]>{
    if(!windowHelper)return [];
    try{
      const raw=await windowHelper('list',{},options.signal);
      if(!Array.isArray(raw))return [];
      return raw.filter((item):item is LaunchWindow=>item&&typeof item==='object'
        &&typeof item.id==='string'&&/^[1-9][0-9]{0,15}$/.test(item.id)
        &&typeof item.title==='string'&&typeof item.processName==='string'
        &&item.processName.toLowerCase()===win32.basename(app).toLowerCase());
    }catch{return [];}
  }
  return {
    async launchPcApp(app: string, rawUrl?: string, filePath?:string, userDataDir?:string): Promise<{ launched: true; app: string;windowId?:string;focused?:boolean }> {
      if (options.signal?.aborted) throw new PcAccessDeniedError();
      const grant = options.authorizer.assert('apps.launch');
      app=normalizePcLaunchApp(app);
      if (!grant.fullAccess&&(!PC_LAUNCHABLE_APPS.includes(app as typeof PC_LAUNCHABLE_APPS[number]) || !grant.allowedApps.includes(app))) throw new PcAccessDeniedError();
      if(rawUrl!==undefined&&filePath!==undefined)throw invalidPcArgument('filePath','Cannot specify both url and filePath');
      if(filePath!==undefined&&(!grant.fullAccess||win32.basename(app).toLowerCase()!=='notepad.exe'))
        throw invalidPcArgument('filePath','File arguments are supported only for Notepad in full access');
      if(rawUrl!==undefined&&win32.basename(app).toLowerCase()==='notepad.exe')throw invalidPcArgument('url','Notepad accepts filePath, not url');
      if(userDataDir!==undefined&&(!grant.fullAccess||!['chrome.exe','msedge.exe'].includes(win32.basename(app).toLowerCase())))
        throw invalidPcArgument('userDataDir','Only Chrome/Edge in full access support a test profile');
      let args:string[]=[];
      if(userDataDir!==undefined){
        if(typeof userDataDir!=='string'||userDataDir.length>1024||userDataDir.includes('\0'))throw invalidPcArgument('userDataDir','Invalid absolute profile path');
        const dir=resolveAllowedPath(userDataDir,grant.roots,{forCreate:true,fullAccess:grant.fullAccess});
        args.push('--user-data-dir='+dir);
        if(rawUrl!==undefined)args.push('--new-window');
      }
      if(filePath!==undefined){
        // A nonexistent document is a file error, not a failed security grant.
        // Check its canonical parent against the approved roots before revealing it.
        if(!existsSync(filePath)){
          resolveAllowedPath(dirname(filePath),grant.roots,{fullAccess:grant.fullAccess});
          throw new PcOperationError('pc_file_not_found');
        }
        const allowed=resolveAllowedPath(filePath,grant.roots,{fullAccess:grant.fullAccess});
        if(!statSync(allowed).isFile())throw invalidPcArgument('filePath','Expected an existing regular file');
        args.push(allowed);
      }else if(rawUrl!==undefined)args.push(validatePcLaunchUrl(rawUrl,grant.roots,grant.fullAccess===true));
      const executable = options.resolve?resolve(app):grant.fullAccess?resolveFullPcApplication(app):resolve(app);
      if (!executable || !win32.isAbsolute(executable)) throw invalidPcArgument('app','Application executable was not found');
      if (options.signal?.aborted || options.authorizer.assert('apps.launch').id !== grant.id) throw new PcAccessDeniedError();
      const before=grant.fullAccess?await listed(app):[];
      const spawnedPid=await spawnApp(executable, args);
      if (options.signal?.aborted || options.authorizer.assert('apps.launch').id !== grant.id) throw new PcAccessDeniedError();
      if(grant.fullAccess&&windowHelper){
        let selected:LaunchWindow|undefined;
        let fallback:LaunchWindow|undefined;
        const known=new Set(before.map(item=>item.id));
        // Browsers may hand their initial process off to a profile-specific child.
        // The before/after window IDs avoid claiming an unrelated existing tab.
        for(let attempt=0;attempt<41;attempt++){
          const current=await listed(app);
          const added=current.filter(item=>!known.has(item.id));
          // Prefer a direct process match. Chrome may delegate to another process,
          // in which case the newly observed browser window is still the candidate.
          selected=added.find(item=>item.processId===spawnedPid)
            ??(rawUrl!==undefined?added.find(item=>item.title.toLowerCase().includes(new URL(rawUrl).hostname.toLowerCase())):undefined)
            ??added[0];
          if(selected)break;
          // Only a plain app activation may legitimately reuse a pre-existing window.
          // A URL, document, or isolated browser profile must not target an unrelated tab.
          fallback=rawUrl===undefined&&filePath===undefined&&userDataDir===undefined&&current.length===1
            ?current[0]:undefined;
          if(attempt<40)await new Promise(resolve=>setTimeout(resolve,100));
        }
        selected??=fallback;
        if(selected){
          if(options.signal?.aborted||options.authorizer.assert('apps.launch').id!==grant.id)throw new PcAccessDeniedError();
          const activation=await windowHelper('activate',{windowId:selected.id,title:selected.title,
            processName:selected.processName},options.signal);
          const focused=!!activation&&typeof activation==='object'&&(activation as {ok?:unknown}).ok===true;
          if(!focused&&(activation as {reason?:unknown}|null)?.reason!=='focus_required')
            throw new PcAccessDeniedError();
          return {launched:true,app,windowId:selected.id,focused};
        }
        return {launched:true,app,focused:false};
      }
      return { launched: true, app };
    },
  };
}
