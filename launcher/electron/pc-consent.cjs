"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");

const MAX_PC_CONSENT_MS = 2 * 60 * 60 * 1_000;
const PERMISSIONS = new Set([
  "status", "files.read", "files.write", "jobs", "terminal.exec", "screen.read", "desktop.input", "adb", "runner",
]);

function deny() {
  return new Error("pc_access_denied");
}

function validateSelection(selection) {
  if (!selection || typeof selection !== "object"
    || (selection.durationMs !== null && (!Number.isSafeInteger(selection.durationMs)
      || selection.durationMs <= 0 || selection.durationMs > MAX_PC_CONSENT_MS))
    || !Array.isArray(selection.roots) || selection.roots.length > 16
    || !selection.roots.every(root => typeof root === "string" && root.length > 1
      && root.length <= 1024 && !root.includes("\0")
      && (path.win32.isAbsolute(root) || path.posix.isAbsolute(root))
      && !root.startsWith("\\\\")
      && root.toLowerCase() !== path.win32.parse(root).root.toLowerCase()
      && root !== path.posix.parse(root).root)
    || !Array.isArray(selection.permissions) || selection.permissions.length < 1
    || selection.permissions.length > PERMISSIONS.size
    || !selection.permissions.every(p => PERMISSIONS.has(p))
    || !Array.isArray(selection.allowedApps) || selection.allowedApps.length > 32
    || !selection.allowedApps.every(app => typeof app === "string" && /^[a-zA-Z0-9_. -]{1,100}$/.test(app))) {
    throw deny();
  }
}

/** Trusted launcher module. No MCP-facing approval endpoint is exported. */
function createPcConsentController({ clock = Date.now, confirmLocally, audit = () => {} }) {
  if (typeof confirmLocally !== "function") throw deny();
  let active;
  let approvalPending = false;
  let revocationGeneration = 0;

  const safeAudit = action => {
    try { audit({ action, at: clock() }); } catch { /* audit failure must not prevent revoke */ }
  };
  return {
    async approve(selection) {
      validateSelection(selection);
      if (approvalPending) throw deny();
      approvalPending = true;
      const approvalGeneration = revocationGeneration;
      try {
        if (await confirmLocally({
          durationMs: selection.durationMs,
          roots: [...selection.roots],
          permissions: [...selection.permissions],
          allowedApps: [...selection.allowedApps],
        }) !== true || revocationGeneration !== approvalGeneration) throw deny();
        const now = clock();
        const grant = {
          id: randomUUID(),
          expiresAt: selection.durationMs === null ? null : now + selection.durationMs,
          roots: [...selection.roots],
          permissions: [...selection.permissions],
          allowedApps: [...selection.allowedApps],
        };
        active = grant;
        safeAudit("approved");
        return { ...grant, roots: [...grant.roots], permissions: [...grant.permissions], allowedApps: [...grant.allowedApps] };
      } finally {
        approvalPending = false;
      }
    },
    /** Called only on launcher startup after OS-protected decryption, never from renderer IPC. */
    restoreTrustedPersistentSelection(selection) {
      validateSelection(selection);
      if (selection.durationMs !== null || approvalPending) throw deny();
      const grant = { id: randomUUID(), expiresAt: null,
        roots: [...selection.roots], permissions: [...selection.permissions],
        allowedApps: [...selection.allowedApps] };
      active = grant;
      safeAudit("restored");
      return { ...grant, roots: [...grant.roots], permissions: [...grant.permissions], allowedApps: [...grant.allowedApps] };
    },
    status() {
      return active && (active.expiresAt === null || active.expiresAt > clock())
        ? { enabled: true, expiresAt: active.expiresAt }
        : { enabled: false };
    },
    revoke() {
      revocationGeneration++;
      active = undefined;
      safeAudit("revoked");
    },
  };
}

module.exports = { createPcConsentController, MAX_PC_CONSENT_MS };
