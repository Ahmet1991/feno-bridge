const test = require("node:test");
const assert = require("node:assert/strict");
const { createPcConsentController, MAX_PC_CONSENT_MS } = require("../electron/pc-consent.cjs");

const NOW = 1_800_000_000_000;
const selection = { durationMs: 60_000, roots: ["D:\\GitHub\\Fenotip"], permissions: ["files.read"], allowedApps: [] };

test("PC consent starts disabled and is approved only by an explicit local confirmation", async () => {
  const events = [];
  let approved = false;
  const controller = createPcConsentController({
    clock: () => NOW,
    confirmLocally: async () => approved,
    audit: event => events.push(event),
  });
  assert.deepEqual(controller.status(), { enabled: false });
  await assert.rejects(controller.approve(selection), /pc_access_denied/);
  assert.deepEqual(controller.status(), { enabled: false });
  approved = true;
  const grant = await controller.approve(selection);
  assert.equal(typeof grant.id, "string");
  assert.deepEqual(grant.permissions, ["files.read"]);
  assert.equal(controller.status().expiresAt, NOW + 60_000);
  controller.revoke();
  assert.deepEqual(controller.status(), { enabled: false });
  assert.deepEqual(events.map(event => event.action), ["approved", "revoked"]);
});

test("rejects excessive duration, malformed scope and stale grants", async () => {
  let now = NOW;
  const controller = createPcConsentController({ clock: () => now, confirmLocally: async () => true, audit: () => {} });
  await assert.rejects(controller.approve({ ...selection, durationMs: MAX_PC_CONSENT_MS + 1 }), /pc_access_denied/);
  await assert.rejects(controller.approve({ ...selection, roots: [""] }), /pc_access_denied/);
  await controller.approve(selection);
  now += 60_000;
  assert.deepEqual(controller.status(), { enabled: false });
});

test("audit receives no project paths, secrets, or approval token", async () => {
  const events = [];
  const controller = createPcConsentController({
    clock: () => NOW,
    confirmLocally: async () => true,
    audit: event => events.push(event),
  });
  const grant = await controller.approve(selection);
  controller.revoke();
  const audited = JSON.stringify(events);
  assert.equal(audited.includes(grant.id), false);
  assert.equal(audited.includes("Fenotip"), false);
  assert.equal(audited.includes("GitHub"), false);
});

test("revoking while the local confirmation is open prevents a late approval", async () => {
  let finishConfirmation;
  const controller = createPcConsentController({
    clock: () => NOW,
    confirmLocally: () => new Promise(resolve => { finishConfirmation = resolve; }),
  });
  const pending = controller.approve(selection);
  controller.revoke();
  finishConfirmation(true);
  await assert.rejects(pending, /pc_access_denied/);
  assert.deepEqual(controller.status(), { enabled: false });
});
