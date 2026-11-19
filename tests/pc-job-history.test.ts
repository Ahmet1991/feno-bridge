import {test,expect} from 'bun:test';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPcJobHistory} from '../src/pc-control/job-history';

test('private job summaries survive process replacement and stay grant scoped',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pc-history-test-'));
  let alive=true;
  const files={ensurePrivateDirectory:(p:string)=>{if(!existsSync(p))mkdirSync(p);},readPrivateFile:(p:string,_max:number)=>readFileSync(p),writePrivateAtomic:writeFileSync,removePrivateFile:unlinkSync,
    inspectProcess:()=>alive?{state:'alive',startTime:'123'}:{state:'dead'}};
  try {
    const history=createPcJobHistory({directory,profileId:'pc2-normal',files});
    const jobId=randomUUID();
    history.write('grant1',{jobId,kind:'terminal',state:'running',startedAt:10,finishedAt:null,exitCode:null,projectRoot:directory,purpose:'fixture',commandHash:'a'.repeat(64)});
    const completed=randomUUID();
    history.write('grant1',{jobId:completed,kind:'job',state:'succeeded',startedAt:20,finishedAt:21,exitCode:0,projectRoot:directory,purpose:null,commandHash:'b'.repeat(64)});
    alive=false;
    const next=createPcJobHistory({directory,profileId:'pc2-normal',files});
    expect(next.list('grant1')).toMatchObject([{jobId:completed,state:'succeeded'},{jobId,state:'interrupted'}]);
    expect(next.list('grant2')).toEqual([]);
    expect(createPcJobHistory({directory,profileId:'pc2-dev',files}).list('grant1')).toEqual([]);
    alive=true;
    const lineage=randomUUID(),owned=randomUUID();
    next.write('grant1',{jobId:owned,kind:'job',state:'succeeded',startedAt:30,finishedAt:31,exitCode:0,projectRoot:directory,purpose:null,commandHash:'c'.repeat(64)},lineage);
    expect(next.list('grant2',lineage)).toMatchObject([{jobId:owned}]);
    expect(next.list('grant2',randomUUID())).toEqual([]);
    expect(next.list('grant1')).toMatchObject([{jobId:completed},{jobId}]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
