"use strict";
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const names = Object.freeze(['private-acl-cli.cjs','private-acl-native.cjs','private-atomic-retry.cjs']);
const deny = () => new Error('pc_private_storage');
const equal = (a,b) => process.platform==='win32' ? a.toLowerCase()===b.toLowerCase() : a===b;
function assertLinkFree(file){
  for(let parent=file;;parent=path.dirname(parent)){
    if(fs.lstatSync(parent).isSymbolicLink())throw deny();
    if(path.dirname(parent)===parent)break;
  }
}

// Reject links/junctions rather than following them. Every component under the
// trusted root must exist and the final canonical path must remain inside it.
function checkedPath(root, file, directory=false) {
  if (!path.isAbsolute(root)||!path.isAbsolute(file)) throw deny();
  const rel=path.relative(root,file);
  if (rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)) throw deny();
  let item=root;
  assertLinkFree(root);
  const base=fs.lstatSync(item);
  if(base.isSymbolicLink()||!base.isDirectory())throw deny();
  const parts=rel ? rel.split(path.sep) : [];
  for (let i=0;i<parts.length;i++) {
    item=path.join(item,parts[i]);
    const st=fs.lstatSync(item);
    if(st.isSymbolicLink()||(i<parts.length-1||directory ? !st.isDirectory() : !st.isFile()))throw deny();
  }
  const realRoot=fs.realpathSync.native(root), realFile=fs.realpathSync.native(item);
  const realRel=path.relative(realRoot,realFile);
  if(realRel==='..'||realRel.startsWith('..'+path.sep)||path.isAbsolute(realRel))throw deny();
  return realFile;
}

function resolveElectronHelper(moduleFile) {
  if(typeof moduleFile!=='string'||!path.isAbsolute(moduleFile))throw deny();
  const base=path.dirname(moduleFile).replace(/app\.asar([\\/]|$)/,'app.asar.unpacked$1');
  return checkedPath(base,path.join(base,names[0]));
}

function resolveRuntimeHelper(entrypoint, executable, pins) {
  if(typeof entrypoint!=='string'||typeof executable!=='string'||!path.isAbsolute(entrypoint)||!path.isAbsolute(executable))throw deny();
  const root=path.dirname(path.dirname(entrypoint));
  if(!equal(path.normalize(entrypoint),path.join(root,'app','cli.js')))throw deny();
  checkedPath(root,entrypoint);
  const expectedExecutable=checkedPath(root,path.join(root,'runtime',process.platform==='win32'?'bun.exe':'bun'));
  assertLinkFree(executable);
  if(!equal(fs.realpathSync.native(executable),expectedExecutable))throw deny();
  const manifest=JSON.parse(fs.readFileSync(checkedPath(root,path.join(root,'manifest.json')),'utf8'));
  if(manifest.schemaVersion!==2||manifest.entrypoint!=='app/cli.js'||!Array.isArray(manifest.files))throw deny();
  let helper;
  for(const name of names){
    const key='runtime/'+name;
    const matches=manifest.files.filter(f=>f.path===key);
    const file=checkedPath(root,path.join(root,'runtime',name));
    const bytes=fs.readFileSync(file);
    const digest=createHash('sha256').update(bytes).digest('hex');
    if(matches.length!==1||matches[0].size!==bytes.length||matches[0].sha256!==digest||pins?.[name]!==digest)throw deny();
    if(name===names[0])helper=file;
  }
  return helper;
}
module.exports={names,checkedPath,resolveElectronHelper,resolveRuntimeHelper};
