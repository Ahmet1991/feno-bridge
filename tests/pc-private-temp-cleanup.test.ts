import {test,expect} from 'bun:test';
import {mkdtempSync,chmodSync,existsSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

const windowsTest=process.platform==='win32'?test:test.skip;
windowsTest('failed replacement leaves no stage; sweep removes only old private stages',async()=>{
  const api=require('../launcher/electron/private-acl-native.cjs');
  const sid=api.getCurrentUserSid();
  const directory=join(mkdtempSync(join(tmpdir(),'pc-private-cleanup-')),'private');
  api.ensurePrivateDirectory(directory,sid);
  const target=join(directory,'fixture.json');
  api.writePrivateAtomic(target,'original',sid);
  chmodSync(target,0o444);
  try{
    expect(()=>api.writePrivateAtomic(target,'replacement',sid)).toThrow();
    expect(readdirSync(directory)).toEqual(['fixture.json']);
  }finally{chmodSync(target,0o666);}
  const old=join(directory,`.pc-private-${randomUUID()}.tmp`);
  api.writePrivateAtomic(old,'old',sid);
  await Bun.sleep(100);
  const cutoff=Math.max(statSync(old).birthtimeMs,statSync(old).mtimeMs)+20;
  const fresh=join(directory,`.pc-private-${randomUUID()}.tmp`);
  const other=join(directory,'other.tmp');
  api.writePrivateAtomic(fresh,'new',sid);
  api.writePrivateAtomic(other,'other',sid);
  expect(api.cleanupPrivateTemps(directory,sid,cutoff+3600000)).toEqual(1);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(other)).toBe(true);
});
