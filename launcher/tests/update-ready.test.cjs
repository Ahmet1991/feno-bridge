const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeReadyMarker, waitForReadyMarker } = require("../electron/update-ready.cjs");

test("update waits for a fresh ready signal from the installed version", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-update-ready-test-"));
  const marker = path.join(root, "launcher-ready.json");
  try {
    writeReadyMarker(marker, "5.0.7", 100);
    const ready = waitForReadyMarker(marker, "5.0.8", 200, { timeoutMs: 300, pollMs: 10 });
    setTimeout(() => writeReadyMarker(marker, "5.0.8", 250), 30);
    assert.deepEqual(await ready, { version: "5.0.8", at: 250 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update reports a timeout when the new window never becomes ready", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-update-ready-test-"));
  try {
    await assert.rejects(
      waitForReadyMarker(path.join(root, "launcher-ready.json"), "5.0.8", 200, {
        timeoutMs: 35,
        pollMs: 10,
      }),
      /did not open within/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
