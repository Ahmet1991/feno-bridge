const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPcConsentChannel } = require("../electron/pc-consent-channel.cjs");

test("local channel starts denied, signs grants and revokes without persisting approval across launcher restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ui-channel-"));
  try {
    const writer = createPcConsentChannel({ directory, clock: () => 1_800_000_000_000 });
    writer.start();
    const statePath = path.join(directory, "pc-consent-state.json");
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).payload.grant, null);
    const key = fs.readFileSync(path.join(directory, "pc-consent-key"), "utf8");
    assert.match(key, /^[a-f0-9]{64}$/);
    writer.activate({ id: "local-test-grant-ui", expiresAt: 1_800_000_030_000,
      roots: ["D:\\GitHub\\Fenotip"], permissions: ["files.read"], allowedApps: [] });
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).payload.grant.id, "local-test-grant-ui");
    writer.revoke();
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).payload.grant, null);
    createPcConsentChannel({ directory, clock: () => 1_800_000_000_000 }).start();
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).payload.grant, null);
    assert.notEqual(fs.readFileSync(path.join(directory, "pc-consent-key"), "utf8"), key);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(statePath).mode & 0o077, 0);
      assert.equal(fs.statSync(path.join(directory, "pc-consent-key")).mode & 0o077, 0);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Windows capture never screenshots another app layered over the approved window", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "electron", "pc-windows-helper.ps1"), "utf8");
  assert.match(script, /PrintWindow/);
  assert.doesNotMatch(script, /CopyFromScreen/);
});
