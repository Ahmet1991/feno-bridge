const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPcConsentChannel } = require("../electron/pc-consent-channel.cjs");
test("consent heartbeat retries a transient Windows rename without changing approval", { skip: process.platform !== "win32" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pc-consent-rename-"));
  const rename = fs.renameSync;
  try {
    let now = 1_800_000_000_000;
    const writer = createPcConsentChannel({ directory, clock: () => now });
    writer.start();
    writer.activate({ id: "same-local-approval", expiresAt: null, roots: [directory], permissions: ["files.read"], allowedApps: [] });
    let attempts = 0;
    fs.renameSync = (source, destination) => {
      if (String(destination) === path.join(directory, "pc-consent-state.json") && attempts++ === 0) {
        throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
      }
      return rename(source, destination);
    };
    now += 5_000;
    writer.heartbeat();
    const { payload } = JSON.parse(fs.readFileSync(path.join(directory, "pc-consent-state.json"), "utf8"));
    assert.equal(attempts, 2);
    assert.equal(payload.grant.id, "same-local-approval");
    assert.equal(payload.heartbeatAt, now);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
