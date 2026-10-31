"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_FILE_BYTES = 16 * 1024;
const deny = () => new Error("pc_access_denied");

/**
 * DEV-only opt-in persistence. It stores a Windows OS-encrypted selection, NOT a
 * reusable signed launcher grant. Each restart mints a fresh grant and HMAC key.
 * Never expose this object's methods through renderer/MCP IPC.
 */
function createPcPersistentConsent({ filePath, encryption }) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)
    || !encryption || typeof encryption.encryptString !== "function"
    || typeof encryption.decryptString !== "function" || typeof encryption.isEncryptionAvailable !== "function") throw deny();

  const assertEncryption = () => {
    if (!encryption.isEncryptionAvailable()) throw deny();
  };

  return {
    save(selection) {
      assertEncryption();
      if (!selection || selection.durationMs !== null || !Array.isArray(selection.roots)
        || !Array.isArray(selection.permissions) || !Array.isArray(selection.allowedApps)) throw deny();
      const plaintext = JSON.stringify({ schema: 1, selection });
      if (Buffer.byteLength(plaintext) > MAX_FILE_BYTES) throw deny();
      const bytes = encryption.encryptString(plaintext);
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) throw deny();
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temp = `${filePath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
        fs.renameSync(temp, filePath);
      } finally {
        try { fs.unlinkSync(temp); } catch { /* already atomically renamed */ }
      }
    },
    restore() {
      try {
        assertEncryption();
        const stats = fs.statSync(filePath);
        if (!stats.isFile() || stats.size < 1 || stats.size > MAX_FILE_BYTES) throw deny();
        const contents = encryption.decryptString(fs.readFileSync(filePath));
        if (typeof contents !== "string" || Buffer.byteLength(contents) > MAX_FILE_BYTES) throw deny();
        const value = JSON.parse(contents);
        if (!value || value.schema !== 1 || !value.selection || value.selection.durationMs !== null) throw deny();
        return value.selection;
      } catch {
        // Invalid, unavailable, and tampered state cannot silently grant access.
        try { fs.unlinkSync(filePath); } catch { /* no persisted access is restored */ }
        return null;
      }
    },
    clear() {
      try { fs.unlinkSync(filePath); }
      catch (error) { if (error.code !== "ENOENT") throw deny(); }
    },
  };
}

module.exports = { createPcPersistentConsent };
