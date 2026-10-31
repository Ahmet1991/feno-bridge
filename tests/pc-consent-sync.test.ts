import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { createPcPolicySync } from "../src/pc-control/consent-sync";

const require = createRequire(import.meta.url);
const { createPcConsentChannel } = require("../launcher/electron/pc-consent-channel.cjs");

test("signed launcher approval crosses into MCP, but revoke and stale heartbeat fail closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "pc-consent-sync-"));
  let now = 1_800_000_000_000;
  try {
    const writer = createPcConsentChannel({ directory, clock: () => now });
    writer.start();
    const authorizer = new PcAuthorizer({ clock: () => now });
    let revocations = 0;
    const sync = createPcPolicySync({ directory, authorizer, clock: () => now, onRevoked: () => { revocations++; } });
    sync.refresh();
    expect(authorizer.status()).toEqual({ enabled: false });
    writer.activate({ id: "local-signed-grant-1", expiresAt: now + 60_000,
      roots: ["D:\\GitHub\\Fenotip"], permissions: ["files.read"], allowedApps: [] });
    sync.refresh();
    expect(authorizer.assert("files.read").id).toBe("local-signed-grant-1");
    now += 20_000;
    sync.refresh();
    expect(() => authorizer.assert("files.read")).toThrow("pc_access_denied");
    writer.heartbeat();
    sync.refresh();
    // After heartbeat loss, fail closed until the user confirms a fresh local approval.
    expect(authorizer.status()).toEqual({ enabled: false });
    writer.activate({ id: "local-signed-grant-1b", expiresAt: now + 60_000,
      roots: ["D:\\GitHub\\Fenotip"], permissions: ["files.read"], allowedApps: [] });
    sync.refresh();
    expect(authorizer.assert("files.read").id).toBe("local-signed-grant-1b");
    writer.activate({ id: "local-signed-grant-1c", expiresAt: now + 60_000,
      roots: ["D:\\GitHub\\Fenotip"], permissions: ["files.read"], allowedApps: [] });
    sync.refresh();
    expect(revocations).toBe(2);
    writer.revoke();
    sync.refresh();
    expect(authorizer.status()).toEqual({ enabled: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("tampered signed state and old launcher key are rejected; approval cannot be set by MCP", () => {
  const directory = mkdtempSync(join(tmpdir(), "pc-consent-tamper-"));
  const now = 1_800_000_000_000;
  try {
    const writer = createPcConsentChannel({ directory, clock: () => now });
    writer.start();
    writer.activate({ id: "local-signed-grant-2", expiresAt: now + 60_000,
      roots: ["D:\\GitHub\\Fenotip"], permissions: ["files.read"], allowedApps: [] });
    const authorizer = new PcAuthorizer({ clock: () => now });
    const sync = createPcPolicySync({ directory, authorizer, clock: () => now });
    const statePath = join(directory, "pc-consent-state.json");
    const original = readFileSync(statePath, "utf8");
    sync.refresh();
    expect(authorizer.status().enabled).toBe(true);
    writeFileSync(statePath, original.replace('"files.read"', '"files.write"'));
    sync.refresh();
    expect(authorizer.status()).toEqual({ enabled: false });
    writeFileSync(statePath, original);
    sync.refresh();
    expect(authorizer.status().enabled).toBe(false);
    writer.activate({ id: "local-signed-grant-new", expiresAt: now + 60_000,
      roots: ["D:\\GitHub\\Fenotip"], permissions: ["files.read"], allowedApps: [] });
    sync.refresh();
    expect(authorizer.status().enabled).toBe(true);
    const newWriter = createPcConsentChannel({ directory, clock: () => now });
    newWriter.start();
    writeFileSync(statePath, original);
    sync.refresh();
    expect(authorizer.status()).toEqual({ enabled: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a locally signed persistent grant remains valid during healthy heartbeats and revokes immediately", () => {
  const directory = mkdtempSync(join(tmpdir(), "pc-consent-persistent-"));
  let now = 1_800_000_000_000;
  try {
    const writer = createPcConsentChannel({ directory, clock: () => now });
    writer.start();
    const authorizer = new PcAuthorizer({ clock: () => now });
    const sync = createPcPolicySync({ directory, authorizer, clock: () => now });
    writer.activate({ id: "local-persistent-grant", expiresAt: null,
      roots: ["D:\\GitHub\\Fenotip"], permissions: ["jobs", "terminal.exec"], allowedApps: [] });
    sync.refresh();
    expect(authorizer.assert("terminal.exec").id).toBe("local-persistent-grant");
    now += 20_000;
    sync.refresh();
    expect(authorizer.status()).toEqual({ enabled: false });
    writer.heartbeat();
    writer.activate({ id: "local-persistent-grant-new", expiresAt: null,
      roots: ["D:\\GitHub\\Fenotip"], permissions: ["jobs", "terminal.exec"], allowedApps: [] });
    sync.refresh();
    expect(authorizer.status()).toEqual({ enabled: true, expiresAt: null });
    writer.revoke();
    sync.refresh();
    expect(() => authorizer.assert("terminal.exec")).toThrow("pc_access_denied");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
