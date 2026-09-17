const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  writeReadyMarker,
  waitForFunctionalReadyMarker,
  waitForReadyMarker,
} = require("../electron/update-ready.cjs");

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

test("new updater does not treat a window-only legacy marker as functional readiness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-update-functional-ready-"));
  const marker = path.join(root, "launcher-ready.json");
  try {
    writeReadyMarker(marker, "5.0.8", 250);
    await assert.rejects(
      waitForFunctionalReadyMarker(marker, "5.0.8", 200, { timeoutMs: 35, pollMs: 10 }),
      /did not become functionally ready/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("functional marker distinguishes ready, sign-in-required, and repair-required outcomes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-update-functional-ready-"));
  const marker = path.join(root, "launcher-ready.json");
  try {
    writeReadyMarker(marker, "5.0.8", 250, { status: "ready", at: 275 });
    assert.deepEqual(
      await waitForFunctionalReadyMarker(marker, "5.0.8", 200, { timeoutMs: 50, pollMs: 5 }),
      { version: "5.0.8", at: 250, startup: { status: "ready", at: 275 } },
    );
    assert.deepEqual(
      await waitForReadyMarker(marker, "5.0.8", 200, { timeoutMs: 50, pollMs: 5 }),
      { version: "5.0.8", at: 250 },
    );

    writeReadyMarker(marker, "5.0.8", 300, { status: "sign-in-required", at: 325 });
    assert.equal(
      (await waitForFunctionalReadyMarker(marker, "5.0.8", 290, { timeoutMs: 50, pollMs: 5 })).startup.status,
      "sign-in-required",
    );

    writeReadyMarker(marker, "5.0.8", 350, { status: "repair-required", at: 375, detail: "runtime failed" });
    await assert.rejects(
      waitForFunctionalReadyMarker(marker, "5.0.8", 340, { timeoutMs: 50, pollMs: 5 }),
      /requires repair.*runtime failed/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("functional readiness rejects stale and wrong-version startup evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-update-functional-ready-"));
  const marker = path.join(root, "launcher-ready.json");
  try {
    writeReadyMarker(marker, "5.0.7", 300, { status: "ready", at: 325 });
    const ready = waitForFunctionalReadyMarker(marker, "5.0.8", 400, { timeoutMs: 150, pollMs: 10 });
    setTimeout(() => writeReadyMarker(marker, "5.0.8", 350, { status: "ready", at: 375 }), 20);
    setTimeout(() => writeReadyMarker(marker, "5.0.8", 450, { status: "ready", at: 475 }), 50);
    assert.equal((await ready).startup.status, "ready");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
