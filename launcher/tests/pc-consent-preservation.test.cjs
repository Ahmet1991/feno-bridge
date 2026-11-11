const test = require('node:test');
const assert = require('node:assert/strict');
const { createPcConsentController } = require('../electron/pc-consent.cjs');
const scope = { durationMs: null, roots: ['D:\\GitHub'], permissions: ['files.read'], allowedApps: [] };

test('saved approval survives suspension, restoration rotates the grant, revoke forgets it', async () => {
  let saved;
  const store = { save(value) { saved = structuredClone(value); }, clear() { saved = undefined; } };
  const first = createPcConsentController({ store, confirmLocally: async () => true });
  const grant = await first.approve(scope);
  assert.deepEqual(saved, scope);
  first.suspend();
  assert.deepEqual(first.status(), { enabled: false, permanentApprovalSaved: true });
  const next = createPcConsentController({ store, confirmLocally: async () => false });
  assert.notEqual(next.restoreTrustedPersistentSelection(saved).id, grant.id);
  assert.equal(next.status().permanentApprovalSaved, true);
  next.revoke();
  assert.equal(saved, undefined);
});

test('approval snapshots the exact displayed scope and persistence precedes activation', async () => {
  let finish;
  const selected = structuredClone(scope);
  let saved;
  const controller = createPcConsentController({ store: { save(value) { saved = value; }, clear() {} },
    confirmLocally: () => new Promise(resolve => { finish = resolve; }) });
  const pending = controller.approve(selected);
  selected.roots[0] = 'C:\\Users';
  selected.permissions.push('terminal.exec');
  finish(true);
  const grant = await pending;
  assert.deepEqual(grant.roots, scope.roots);
  assert.deepEqual(grant.permissions, scope.permissions);
  assert.deepEqual(saved, scope);
  const failing = createPcConsentController({ confirmLocally: async () => true,
    store: { save() { throw Error('disk failure'); }, clear() {} } });
  await assert.rejects(failing.approve(scope), /disk failure/);
  assert.equal(failing.status().enabled, false);
});

test('timed approval clears saved approval; failed clearing still suspends access', async () => {
  let saved;
  let fail = false;
  const store = { save(value) { saved = value; }, clear() { if (fail) throw Error('clear failure'); saved = undefined; } };
  const controller = createPcConsentController({ store, confirmLocally: async () => true });
  await controller.approve(scope);
  await controller.approve({ ...scope, durationMs: 60000 });
  assert.equal(saved, undefined);
  await controller.approve(scope);
  fail = true;
  assert.throws(() => controller.revoke(), /clear failure/);
  assert.deepEqual(controller.status(), { enabled: false, permanentApprovalSaved: true });
});
