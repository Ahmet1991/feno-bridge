import {expect,test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
test.if(process.platform==='win32')('moving an opened file outside the root before writing preserves replacement data and rejects the write',()=>{
  const result=spawnSync(process.execPath,[join(import.meta.dir,'fixtures/pc-create-leaf-probe.ts')],{encoding:'utf8'});
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({denied:true,outsideContent:'',insideContent:'replacement'});
});

test.if(process.platform==='win32')('the file itself remains protected from rename throughout the content write',()=>{
  const result=spawnSync(process.execPath,[join(import.meta.dir,'fixtures/pc-create-leaf-probe.ts'),'during-write'],{encoding:'utf8'});
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({denied:false,renameBlocked:true,outsideContent:null,insideContent:'fixture-payload'});
});
