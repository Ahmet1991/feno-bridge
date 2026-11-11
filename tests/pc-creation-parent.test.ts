import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { holdCreationParent } from "../src/pc-control/creation-parent";
import { createPcDirectory, createPcFile } from "../src/pc-control/files";
import { PcAuthorizer } from "../src/pc-control/authorization";

test('held parent cannot redirect Windows creation through an ancestor junction swap', () => {
  if (process.platform !== 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'pc-parent-lock-'));
  const parent = join(root, 'parent');
  mkdirSync(parent);
  const held = holdCreationParent(parent);
  try { expect(() => renameSync(parent, join(root, 'moved'))).toThrow(); }
  finally { held.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ['file', 'directory']) test.if(process.platform === 'win32')(`new ${kind} rejects a parent changed before the asynchronous operation completes`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-create-race-'));
  const outside = mkdtempSync(join(tmpdir(), 'pc-create-outside-'));
  const parent = join(root, 'parent');
  const moved = join(root, 'moved');
  mkdirSync(parent);
  const auth = new PcAuthorizer();
  auth.setGrantFromLocalApproval({ id: 'local-creation-race', expiresAt: null, roots: [root], permissions: ['files.write'], allowedApps: [] });
  const output = join(parent, 'created');
  const operation = kind === 'file' ? createPcFile(output, 'approved content', auth) : createPcDirectory(output, auth);
  let swapped = false;
  try {
    if (process.platform === 'win32') expect(() => renameSync(parent, moved)).toThrow();
    try { renameSync(parent, moved); symlinkSync(outside, parent, 'junction'); swapped = true; } catch { /* held Windows parent cannot be renamed */ }
    const result = await operation.catch(() => null);
    expect(existsSync(join(outside, 'created'))).toBe(false);
    if (result && kind === 'file') expect(readFileSync(join(swapped ? moved : parent, 'created'), 'utf8')).toBe('approved content');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

for (const kind of ['file', 'directory']) test.if(process.platform === 'win32')(`revocation during ${kind} creation removes only its own new object`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-create-revoke-'));
  const auth = new PcAuthorizer();
  auth.setGrantFromLocalApproval({ id: 'local-create-revoke', expiresAt: null, roots: [root], permissions: ['files.write'], allowedApps: [] });
  const output = join(root, 'created');
  try {
    const pending = kind === 'file' ? createPcFile(output, 'approved content', auth) : createPcDirectory(output, auth);
    auth.revoke();
    await expect(pending).rejects.toThrow('pc_access_denied');
    expect(existsSync(output)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
