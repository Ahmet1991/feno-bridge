"use strict";

const { createHmac, randomBytes, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");

const KEY_FILE = "pc-consent-key";
const STATE_FILE = "pc-consent-state.json";
const PC_HEARTBEAT_RENEW_AFTER_MS = 15_000;

function writePrivateAtomic(directory, name, content) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    renameAtomicFile(temp, path.join(directory, name));
    if (process.platform !== "win32") fs.chmodSync(path.join(directory, name), 0o600);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already atomically renamed */ }
  }
}

/** Launcher-only writer; the MCP server has no way to call activate. */
function createPcConsentChannel({ directory, clock = Date.now }) {
  if (!path.isAbsolute(directory)) throw new Error("pc_access_denied");
  let key;
  let grant = null;
  let lastPublishedAt;
  let lastPublishedGrantId;

  function publish() {
    if (!key) throw new Error("pc_access_denied");
    const now = clock();
    if (grant && grant.expiresAt !== null && grant.expiresAt <= now) grant = null;
    // Renew only the transport identity of an existing local approval after a gap.
    // The verifier still rejects old/replayed identities; scope and expiry never grow.
    const interrupted = lastPublishedAt !== undefined
      && (now - lastPublishedAt >= PC_HEARTBEAT_RENEW_AFTER_MS || now < lastPublishedAt);
    const candidate = grant && grant.id === lastPublishedGrantId && interrupted
      ? { ...grant, id: randomUUID() } : grant;
    const payload = { schema: 1, heartbeatAt: now, grant: candidate };
    const signature = createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
    writePrivateAtomic(directory, STATE_FILE, JSON.stringify({ payload, signature }));
    grant = candidate;
    lastPublishedAt = now;
    lastPublishedGrantId = candidate?.id;
  }

  return {
    start() {
      // A launcher restart invalidates every earlier signed grant, even before its TTL.
      key = randomBytes(32);
      grant = null;
      writePrivateAtomic(directory, KEY_FILE, key.toString("hex"));
      publish();
    },
    activate(locallyApprovedGrant) {
      if (!key || !locallyApprovedGrant || typeof locallyApprovedGrant.id !== "string"
        || (locallyApprovedGrant.expiresAt !== null && (!Number.isSafeInteger(locallyApprovedGrant.expiresAt)
          || locallyApprovedGrant.expiresAt <= clock()))) throw new Error("pc_access_denied");
      grant = {
        id: locallyApprovedGrant.id, expiresAt: locallyApprovedGrant.expiresAt,
        roots: [...locallyApprovedGrant.roots], permissions: [...locallyApprovedGrant.permissions],
        allowedApps: [...locallyApprovedGrant.allowedApps],
      };
      publish();
    },
    heartbeat() { publish(); },
    revoke() { grant = null; publish(); },
  };
}

/** Also used before fatal-error UI: no active lease or heartbeat may outlive startup. */
function suspendPcAccess({ controller, channel, heartbeat }) {
  if (heartbeat) clearInterval(heartbeat);
  controller?.suspend();
  channel?.revoke();
}

module.exports = { createPcConsentChannel, suspendPcAccess, KEY_FILE, STATE_FILE, PC_HEARTBEAT_RENEW_AFTER_MS };
