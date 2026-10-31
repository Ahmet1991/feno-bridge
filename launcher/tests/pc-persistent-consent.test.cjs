const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createPcPersistentConsent } = require("../electron/pc-persistent-consent.cjs");

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: plaintext => Buffer.from(`protected:${plaintext}`, "utf8"),
  decryptString: buffer => {
    const value = buffer.toString("utf8");
    if (!value.startsWith("protected:")) throw Error("invalid encrypted file");
    return value.slice("protected:".length);
  },
};

test("local durable DEV selection is encrypted, restored only from protected storage and can be cleared", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feno-persistent-test-"));
  const filePath = path.join(directory, "protected-consent.bin");
  const storage = createPcPersistentConsent({ filePath, encryption });
  const selection = { durationMs: null, roots: ["D:\\GitHub"], permissions: ["jobs", "terminal.exec"], allowedApps: [] };
  try {
    assert.equal(storage.restore(), null);
    storage.save(selection);
    const content = fs.readFileSync(filePath, "utf8");
    assert.equal(content.includes("D:\\GitHub"), false);
    assert.deepEqual(storage.restore(), selection);
    storage.clear();
    assert.equal(storage.restore(), null);
    assert.equal(fs.existsSync(filePath), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("storage fails closed when Windows encryption is unavailable or the consent file is tampered", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feno-persistent-test-"));
  const filePath = path.join(directory, "protected-consent.bin");
  const storage = createPcPersistentConsent({ filePath, encryption });
  try {
    assert.throws(() => createPcPersistentConsent({ filePath, encryption: {
      ...encryption, isEncryptionAvailable: () => false,
    } }).save({ durationMs: null, roots: ["D:\\GitHub"], permissions: ["jobs"], allowedApps: [] }), /pc_access_denied/);
    fs.writeFileSync(filePath, "plain-text-unauthorized-grant");
    assert.equal(storage.restore(), null);
    assert.equal(fs.existsSync(filePath), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
