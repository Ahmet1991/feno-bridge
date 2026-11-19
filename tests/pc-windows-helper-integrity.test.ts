import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createVerifiedWindowsHelper, pcWindowsHelperStatus } from '../src/pc-control/windows';

test('helper deadline waits for process close and reports distinct failure reasons', async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-helper-errors-'));
  try{
    const executablePath=join(root,'fake.exe'),manifestPath=join(root,'trusted.sha256');
    writeFileSync(executablePath,'fixture');writeFileSync(manifestPath,createHash('sha256').update('fixture').digest('hex'));
    let child!:EventEmitter & {stdout:PassThrough;kill:()=>boolean};let killed=false;
    const helper=createVerifiedWindowsHelper({executablePath,manifestPath,timeoutMs:15,spawnHelper:(()=>{
      child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),kill:()=>{killed=true;return true;}});return child;
    }) as never});
    let settled=false;const pending=helper('session',{}).catch(e=>{settled=true;return e;});
    await Bun.sleep(35);expect(killed).toBe(true);expect(settled).toBe(false);
    child.emit('close',null);expect(await pending).toMatchObject({code:'pc_helper_timeout'});
    const bad=helper('session',{}).catch(e=>e);child.emit('close',7);
    expect(await bad).toMatchObject({code:'pc_helper_failed',details:{reason:'exit_code_7'}});
    const empty=helper('session',{}).catch(e=>e);child.emit('close',0);
    expect(await empty).toMatchObject({code:'pc_helper_failed',details:{reason:'invalid_output'}});
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('missing helper fails closed without spawning and appears unavailable in status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc2-integrity-'));
  try {
    const executablePath = join(root, 'missing.exe');
    const manifestPath = join(root, 'trusted.sha256');
    writeFileSync(manifestPath, 'a'.repeat(64) + '\n');
    let starts = 0;
    const helper = createVerifiedWindowsHelper({ executablePath, manifestPath, spawnHelper: (() => { starts++; throw Error('must not spawn'); }) as never });
    expect(helper('session', {})).rejects.toMatchObject({ code: 'pc_helper_missing' });
    expect(starts).toBe(0);
    expect(pcWindowsHelperStatus({ executablePath, manifestPath })).toEqual({ available: false, reason: 'pc_helper_missing' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('modified bytes fail closed even when helper path exists; no process starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc2-integrity-'));
  try {
    const executablePath = join(root, 'fake.exe');
    const manifestPath = join(root, 'trusted.sha256');
    writeFileSync(executablePath, 'trusted fake helper');
    writeFileSync(manifestPath, createHash('sha256').update(readFileSync(executablePath)).digest('hex') + '\n');
    writeFileSync(executablePath, 'tampered fake helper');
    let starts = 0;
    const helper = createVerifiedWindowsHelper({ executablePath, manifestPath, spawnHelper: (() => { starts++; throw Error('must not spawn'); }) as never });
    expect(helper('list', {})).rejects.toMatchObject({ code: 'pc_helper_untrusted' });
    expect(starts).toBe(0);
    expect(pcWindowsHelperStatus({ executablePath, manifestPath })).toEqual({ available: false, reason: 'pc_helper_untrusted' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('trusted helper flows through to subprocess and hash is rechecked before each spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc2-integrity-'));
  try {
    const executablePath = join(root, 'fake.exe');
    const manifestPath = join(root, 'trusted.sha256');
    writeFileSync(executablePath, 'trusted fake helper');
    writeFileSync(manifestPath, createHash('sha256').update(readFileSync(executablePath)).digest('hex') + '\n');
    const calls: Array<{ executable: string; args: string[] }> = [];
    const spawnHelper = ((executable: string, args: string[]) => {
      calls.push({ executable, args });
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean };
      child.stdout = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => { child.stdout.end('{"unlocked":true}'); child.emit('close', 0); });
      return child;
    }) as never;
    const helper = createVerifiedWindowsHelper({ executablePath, manifestPath, spawnHelper });
    expect(pcWindowsHelperStatus({ executablePath, manifestPath })).toEqual({ available: true });
    expect(await helper('session', {})).toEqual({ unlocked: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.executable).toBe(executablePath);
    expect(JSON.parse(Buffer.from(calls[0]!.args[1]!, 'base64').toString('utf8'))).toEqual({ action: 'session', args: {} });
    writeFileSync(executablePath, 'changed between calls');
    expect(helper('session', {})).rejects.toMatchObject({ code: 'pc_helper_untrusted' });
    expect(calls).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
