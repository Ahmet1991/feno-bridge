import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PcAuthorizer } from '../src/pc-control/authorization';
import { resolveAllowedPath } from '../src/pc-control/paths';
import type { PcGrant } from '../src/pc-control/types';
const permissions=['files.read','files.write','jobs','terminal.exec','screen.read','desktop.input','adb','runner'] as const;
const grant=(extra:Partial<PcGrant>={}):PcGrant=>({profileId:'pc2-normal',id:'fixture-grant-0001',expiresAt:61000,roots:['D:\\GitHub\\fixture'],permissions:['files.read'],allowedApps:[],...extra});

test('normal starts denied for every permission and a DEV approval cannot enable it',()=>{
  const normal=new PcAuthorizer({profileId:'pc2-normal',clock:()=>1000});
  expect(normal.status()).toEqual({enabled:false});
  for(const p of permissions)expect(()=>normal.assert(p)).toThrow('pc_access_denied');
  expect(()=>normal.setGrantFromLocalApproval(grant({profileId:'pc2-dev'}))).toThrow('pc_access_denied');
  expect(normal.status().enabled).toBe(false);
});
test('expiry, excessive TTL, replay after revoke and unknown permissions are rejected',()=>{
  let now=1000; const normal=new PcAuthorizer({profileId:'pc2-normal',clock:()=>now});
  expect(()=>normal.setGrantFromLocalApproval(grant({expiresAt:1000}))).toThrow();
  expect(()=>normal.setGrantFromLocalApproval(grant({expiresAt:7201001}))).toThrow();
  expect(()=>normal.setGrantFromLocalApproval(grant({permissions:['files.read','files.read']}))).toThrow();
  normal.setGrantFromLocalApproval(grant()); normal.revoke();
  expect(()=>normal.setGrantFromLocalApproval(grant())).toThrow();
  normal.setGrantFromLocalApproval(grant({id:'fixture-grant-0002'})); now=61000;
  expect(normal.status().enabled).toBe(false); expect(()=>normal.assert('files.read')).toThrow();
});
test('caller mutation and returned grant mutation cannot add authority',()=>{
  const normal=new PcAuthorizer({profileId:'pc2-normal',clock:()=>1000}); const input=grant();
  normal.setGrantFromLocalApproval(input); input.permissions.push('terminal.exec');
  normal.assert('files.read').permissions.push('files.write');
  expect(()=>normal.assert('terminal.exec')).toThrow();expect(()=>normal.assert('files.write')).toThrow();
});
test('temporary suspension accepts the identical grant, never a changed or explicitly revoked one',()=>{
  const auth=new PcAuthorizer({profileId:'pc2-normal',clock:()=>1000});
  auth.setGrantFromLocalApproval(grant());auth.suspend();
  expect(()=>auth.setGrantFromLocalApproval(grant({...{permissions:['files.read','jobs']}}))).toThrow('pc_access_denied');
  auth.setGrantFromLocalApproval(grant());expect(auth.status().enabled).toBe(true);
  auth.revoke();expect(()=>auth.setGrantFromLocalApproval(grant())).toThrow('pc_access_denied');
});
test('canonical root policy rejects sibling prefixes, junction escape and out-of-root creation',()=>{
  const root=mkdtempSync(join(tmpdir(),'pc-path-security-'));const project=join(root,'project');const sibling=join(root,'project-other');
  mkdirSync(project);mkdirSync(sibling);writeFileSync(join(project,'inside.txt'),'inside');writeFileSync(join(sibling,'outside.txt'),'outside');
  expect(resolveAllowedPath(join(project,'inside.txt'),[project])).toBe(join(project,'inside.txt'));
  expect(()=>resolveAllowedPath(join(sibling,'outside.txt'),[project])).toThrow('pc_access_denied');
  expect(()=>resolveAllowedPath(join(sibling,'new.txt'),[project],{forCreate:true})).toThrow('pc_access_denied');
  symlinkSync(sibling,join(project,'escape'),process.platform==='win32'?'junction':'dir');
  expect(()=>resolveAllowedPath(join(project,'escape/outside.txt'),[project])).toThrow('pc_access_denied');
});
