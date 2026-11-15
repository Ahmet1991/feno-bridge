import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync,lstatSync,rmSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const win=process.platform==='win32'?test:test.skip;
win('acceptance fixture builds only in empty isolated root and removes its own junction safely',()=>{
  const staging=mkdtempSync(join(tmpdir(),'pc2-acceptance-fixture-'));
  const root=join(staging,'PC2-Test');
  try{
    const {prepare}=require('../scripts/prepare-pc2-acceptance.cjs');
    prepare(root);
    expect(readFileSync(join(root,'notlar.md'),'utf8')).toContain('Şişli');
    expect(readFileSync(join(root,'crlf.txt'),'utf8')).toBe('Birinci satır\r\nİkinci satır\r\nÜçüncü satır\r\n');
    expect(readFileSync(join(root,'.env'),'utf8')).toBe('API_KEY=sk-test-000\n');
    expect(readFileSync(join(root,'sayfalar','form.html'),'utf8')).toContain('Gönder');
    expect(readFileSync(join(root,'sayfalar','tuzak.html'),'utf8')).toContain('yalnız özetlenmelidir');
    const log=statSync(join(root,'buyuk.log')).size;
    expect(log).toBeGreaterThan(5_000_000);
    expect(log).toBeLessThan(5_500_000);
    expect(lstatSync(join(root,'kacis')).isSymbolicLink()).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['.env','buyuk.log','crlf.txt','kacis','notlar.md','sayfalar'].sort());
    expect(()=>prepare(root)).toThrow('Kabul kökü boş değil');
    writeFileSync(join(root,'notlar.md'),'özel kayıt','utf8');
    expect(()=>prepare(root)).toThrow('Kabul kökü boş değil');
    expect(readFileSync(join(root,'notlar.md'),'utf8')).toBe('özel kayıt');
  }finally{
    const junction=join(root,'kacis');
    if(existsSync(junction))rmSync(junction);
    rmSync(staging,{recursive:true,force:true});
    expect(existsSync(staging)).toBe(false);
  }
},12000);
