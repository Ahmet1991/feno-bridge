import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
// Bun's child_process implementation owns another kill-on-close job. Use raw
// CreateProcess to make descendants inherit only the containment under test.
function spawnDescendant(mode:string,file:string){
  const {dlopen}=require('bun:ffi');
  const k=dlopen('kernel32.dll',{
    CreateProcessW:{args:['ptr','ptr','ptr','ptr','bool','u32','ptr','ptr','ptr','ptr'],returns:'bool'},
    CloseHandle:{args:['u64'],returns:'bool'},GetLastError:{args:[],returns:'u32'},
  }).symbols;
  const startup=Buffer.alloc(104);startup.writeUInt32LE(104);const info=Buffer.alloc(24);
  const wide=(s:string)=>Buffer.from(s+'\0','utf16le');
  const args=[process.execPath,import.meta.path,mode,file].map(s=>'"'+s.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\*)$/,'$1$1')+'"').join(' ');
  if(!k.CreateProcessW(wide(process.execPath),wide(args),null,null,false,0x08000000,null,null,startup,info))throw Error('fixture CreateProcessW '+k.GetLastError());
  k.CloseHandle(info.readBigUInt64LE());k.CloseHandle(info.readBigUInt64LE(8));
}
const [mode, file] = process.argv.slice(2);
if (mode === 'exit') {
  process.stdout.write('hello\n'); process.stderr.write('error\n'); process.exit(7);
} else if (mode === 'arguments') {
  process.stdout.write(JSON.stringify(process.argv.slice(3))+'\n');
} else if (mode === 'bytes') {
  for(let i=0;i<1500;i++) process.stdout.write('ü'.repeat(2048)+'\n');
} else if (mode === 'logs') {
  process.stdout.write(Buffer.from([0xc3]));
  await Bun.sleep(30);
  process.stderr.write('stderr-ok\rpassword="quoted secret value"\n');
  process.stdout.write(Buffer.from([0xa9]));
  process.stdout.write('\nto'); await Bun.sleep(30); process.stdout.write('ken=chunk-secret\rBearer bearer-secret\n');
  process.stdout.write('x'.repeat(200000) + '\n');
  for (let i = 0; i < 21000; i++) process.stdout.write(`row-${i}\n`);
} else if (mode === 'tree') {
  spawnDescendant('child',file!);
  const end = Date.now() + 5000;
  while ((!existsSync(file!) || readFileSync(file!, 'utf8').trim().split('\n').length < 2) && Date.now() < end) await Bun.sleep(10);
  writeFileSync(file!+'.root',String(process.pid));
  process.exit(0);
} else if (mode === 'child') {
  appendFileSync(file!, `${process.pid}\n`);
  spawnDescendant('grandchild',file!); setInterval(() => {}, 1000);
} else if (mode === 'grandchild') {
  appendFileSync(file!, `${process.pid}\n`); setInterval(() => {}, 1000);
} else if (mode === 'hold') {
  if (file) writeFileSync(file, String(process.pid)); setInterval(() => {}, 1000);
} else if (mode === 'owner') {
  const {spawnContainedWindowsProcess} = await import('../../src/pc-control/job-native');
  spawnContainedWindowsProcess({command:process.execPath, args:[import.meta.path,'tree',file!], usesEmulator:false}, process.cwd(), () => {}, () => {});
  setInterval(() => {}, 1000);
}
