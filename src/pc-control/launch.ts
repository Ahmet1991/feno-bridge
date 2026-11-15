import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { PcAccessDeniedError, PcAuthorizer } from './authorization';

export const PC_LAUNCHABLE_APPS = ['notepad.exe', 'chrome.exe', 'msedge.exe'] as const;
export type PcLaunchableApp = typeof PC_LAUNCHABLE_APPS[number];

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

export function validatePcLaunchUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 2048 || /[\s\x00-\x1f\x7f]/.test(raw)) throw new PcAccessDeniedError();
  let url: URL;
  try { url = new URL(raw); } catch { throw new PcAccessDeniedError(); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.href !== raw || raw.includes('\\')) throw new PcAccessDeniedError();
  return url.href;
}

export function createPcApplicationLauncher(options: {
  authorizer: PcAuthorizer;
  resolve?: (app: PcLaunchableApp) => string | undefined;
  spawnApp?: (executable: string, args: string[]) => void | Promise<void>;
  signal?: AbortSignal;
}) {
  const resolve = options.resolve ?? resolveTrustedPcApplication;
  const spawnApp = options.spawnApp ?? ((executable: string, args: string[]) => new Promise<void>((resolve, reject) => {
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
      resolve();
    });
  }));
  return {
    async launchPcApp(app: string, rawUrl?: string): Promise<{ launched: true; app: PcLaunchableApp }> {
      if (options.signal?.aborted) throw new PcAccessDeniedError();
      const grant = options.authorizer.assert('apps.launch');
      if (!PC_LAUNCHABLE_APPS.includes(app as PcLaunchableApp) || !grant.allowedApps.includes(app)) throw new PcAccessDeniedError();
      const args = rawUrl === undefined ? [] : app === 'notepad.exe' ? (() => { throw new PcAccessDeniedError(); })() : [validatePcLaunchUrl(rawUrl)];
      const executable = resolve(app as PcLaunchableApp);
      if (!executable || !win32.isAbsolute(executable)) throw new PcAccessDeniedError();
      if (options.signal?.aborted || options.authorizer.assert('apps.launch').id !== grant.id) throw new PcAccessDeniedError();
      await spawnApp(executable, args);
      if (options.signal?.aborted || options.authorizer.assert('apps.launch').id !== grant.id) throw new PcAccessDeniedError();
      return { launched: true, app: app as PcLaunchableApp };
    },
  };
}
