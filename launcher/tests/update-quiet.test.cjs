const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createUpdateController, waitForQuietRuntime } = require("../electron/update.cjs");

// 20.10: the Update button proved the session idle, then spent three minutes downloading, and the
// restart cancelled the Codex task that had started meanwhile.

function clock(samples) {
  let at = 0;
  let index = 0;
  return {
    now: () => at,
    sleep: async (milliseconds) => { at += milliseconds; },
    readActivity: async () => samples[Math.min(index++, samples.length - 1)](at),
  };
}

test("an update starts at once when no Codex turn has run", async () => {
  const fake = clock([() => ({ active: 0, lastEndedAt: null })]);
  assert.deepEqual(await waitForQuietRuntime(fake), { quiet: true, waitedMs: 0 });
});

test("an update waits for a running turn and the tool gap after it", async () => {
  const fake = clock([
    () => ({ active: 1, lastEndedAt: null }),
    () => ({ active: 1, lastEndedAt: null }),
    // The turn ended at 4s; Codex runs local tools, then the next turn starts at 30s.
    () => ({ active: 0, lastEndedAt: 4_000 }),
    () => ({ active: 1, lastEndedAt: 4_000 }),
    () => ({ active: 0, lastEndedAt: 40_000 }),
  ]);
  const result = await waitForQuietRuntime({ ...fake, quietMs: 120_000, pollMs: 10_000 });
  assert.equal(result.quiet, true);
  assert.ok(result.waitedMs >= 160_000, `waited only ${result.waitedMs}ms after the last turn`);
});

test("an update proceeds after the timeout as the confirmation warned", async () => {
  const fake = clock([() => ({ active: 1, lastEndedAt: null })]);
  const result = await waitForQuietRuntime({ ...fake, timeoutMs: 60_000, pollMs: 10_000 });
  assert.deepEqual(result, { quiet: false, waitedMs: 60_000, reason: "timeout" });
});

test("an update does not wait on a runtime whose activity cannot be read", async () => {
  const fake = clock([() => null]);
  assert.deepEqual(await waitForQuietRuntime(fake), { quiet: false, waitedMs: 0, reason: "activity-unavailable" });
});

test("cancelling the update stops the wait", async () => {
  const controller = new AbortController();
  const fake = clock([() => {
    controller.abort(new Error("Update preparation cancelled"));
    return { active: 1, lastEndedAt: null };
  }]);
  await assert.rejects(waitForQuietRuntime({ ...fake, signal: controller.signal }), /cancelled/);
});

test("the worker starts only after the quiet wait, because it gives the launcher two minutes to exit", async () => {
  const body = Buffer.from("installer");
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const order = [];
  const controller = createUpdateController({
    currentVersion: "1.1.4",
    platform: "win32",
    arch: "x64",
    packaged: true,
    executablePath: "C:\\Feno Bridge.exe",
    runtimeExecutable: "C:\\bun.exe",
    logsDirectory: "C:\\logs",
    dependencies: {
      fetchRelease: async () => ({
        tag_name: "v1.2.0",
        assets: [
          {
            name: "feno-bridge-1.2.0-win-x64.exe",
            browser_download_url: "https://github.com/Ahmet1991/feno-bridge/releases/download/v1.2.0/feno-bridge-1.2.0-win-x64.exe",
          },
          {
            name: "checksums.txt",
            browser_download_url: "https://github.com/Ahmet1991/feno-bridge/releases/download/v1.2.0/checksums.txt",
          },
        ],
      }),
      downloadText: async () => `${hash}  feno-bridge-1.2.0-win-x64.exe\n`,
      downloadFile: async (_url, destination) => {
        order.push("download");
        fs.writeFileSync(destination, body);
      },
      sha256: (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
      spawnWorker: () => {
        order.push("worker");
        return { pid: 123, unref() {}, kill() {} };
      },
    },
  });
  await controller.checkOnce();
  const launch = await controller.beginInstall({
    beforeLaunch: async ({ signal }) => {
      assert.equal(signal.aborted, false);
      assert.equal(controller.getState().status, "downloading");
      order.push("quiet");
    },
  });
  assert.deepEqual(order, ["download", "quiet", "worker"]);
  assert.equal(controller.getState().status, "installing");
  controller.cancelInstall(launch);
});
