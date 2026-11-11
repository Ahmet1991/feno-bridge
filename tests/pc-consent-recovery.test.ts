import { expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { createPcPolicySync, PC_HEARTBEAT_MAX_AGE_MS } from "../src/pc-control/consent-sync";
const require = createRequire(import.meta.url);
const { createPcConsentChannel, PC_HEARTBEAT_RENEW_AFTER_MS } = require("../launcher/electron/pc-consent-channel.cjs");

for (const mode of ["recover", "revoke", "expire", "clock-backwards"]) {
  test(`publisher heartbeat outage: ${mode}, without widening the approved scope`, () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "pc-publisher-recovery-"));
    let now = 1_800_000_000_000;
    const originalRename = fs.renameSync;
    try {
      const writer = createPcConsentChannel({ directory, clock: () => now });
      writer.start();
      const approved = { id: "original-local-approval", expiresAt: mode === "expire" ? now + 10_000 : null,
        roots: ["D:\\GitHub"], permissions: ["files.read"], allowedApps: [] };
      writer.activate(approved);
      const authorizer = new PcAuthorizer({ clock: () => now });
      const sync = createPcPolicySync({ directory, authorizer, clock: () => now });
      sync.refresh();
      const statePath = join(directory, "pc-consent-state.json");
      const oldEnvelope = fs.readFileSync(statePath, "utf8");
      fs.renameSync = (source, destination) => {
        if (String(destination) === statePath) throw Object.assign(new Error("test write outage"), { code: "EIO" });
        return originalRename(source, destination);
      };
      now += 5_000;
      expect(() => writer.heartbeat()).toThrow("test write outage");
      if (mode === "revoke") expect(() => writer.revoke()).toThrow("test write outage");
      now += 20_000;
      if (mode === "clock-backwards") now -= 40_000;
      sync.refresh();
      expect(authorizer.status().enabled).toBe(false);
      fs.renameSync = originalRename;
      writer.heartbeat();
      sync.refresh();
      const current = JSON.parse(fs.readFileSync(statePath, "utf8")).payload;
      if (mode === "recover" || mode === "clock-backwards") {
        expect(authorizer.status()).toEqual({ enabled: true, expiresAt: null });
        expect(current.grant).toEqual({ ...approved, id: expect.any(String) });
        expect(current.grant.id).not.toBe(approved.id);
        // A previously accepted signed envelope must remain unusable after renewal.
        fs.writeFileSync(statePath, oldEnvelope);
        sync.refresh();
        expect(authorizer.status().enabled).toBe(false);
      } else {
        expect(current.grant).toBeNull();
        expect(authorizer.status().enabled).toBe(false);
      }
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
test("publisher renewal threshold matches the verifier freshness window", () => {
  expect(PC_HEARTBEAT_RENEW_AFTER_MS).toBe(PC_HEARTBEAT_MAX_AGE_MS);
});
