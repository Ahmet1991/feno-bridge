const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { holdWindowsAwake, runWindowsInstaller } = require("../electron/update-installer.cjs");

function fakeInstaller() {
  const child = new EventEmitter();
  child.pid = 4242;
  return child;
}

test("a silent installer that exits 0 completes the install step", async () => {
  const child = fakeInstaller();
  const started = [];
  const run = runWindowsInstaller("setup.exe", {
    tickMs: 5,
    spawnInstaller: (file, args) => { started.push([file, args]); return child; },
    killTree: () => assert.fail("a finishing installer must not be killed"),
  });
  setTimeout(() => child.emit("exit", 0), 20);
  await run;
  assert.deepEqual(started, [["setup.exe", ["/S"]]]);
});

test("a failing installer reports its exit code", async () => {
  const child = fakeInstaller();
  const run = runWindowsInstaller("setup.exe", { tickMs: 5, spawnInstaller: () => child, killTree: () => {} });
  setTimeout(() => child.emit("exit", 2), 10);
  await assert.rejects(run, /exited with code 2/);
});

test("time the machine spent suspended does not count toward the installer timeout (28.09)", async () => {
  // Every clock read advances 5 ms, except one that jumps 95 minutes: modern standby mid-install.
  let clock = 0;
  let reads = 0;
  const now = () => {
    reads += 1;
    clock += reads === 3 ? 95 * 60_000 : 5;
    return clock;
  };
  const child = fakeInstaller();
  const killed = [];
  await assert.rejects(
    runWindowsInstaller("setup.exe", {
      timeoutMs: 50,
      tickMs: 5,
      now,
      spawnInstaller: () => child,
      killTree: (pid) => killed.push({ pid, reads }),
    }),
    /awake time/,
  );
  // Killed only after 50 ms of awake ticks, not on the first tick after waking, and as a tree.
  assert.equal(killed.length, 1);
  assert.equal(killed[0].pid, 4242);
  assert.ok(killed[0].reads >= 12, `killed after ${killed[0].reads} clock reads`);
});

test("keeping the machine awake holds the execution state until released", () => {
  const spawned = [];
  let stdinEnded = false;
  const release = holdWindowsAwake({
    spawnProcess: (file, args, options) => {
      spawned.push({ file, args, options });
      const child = new EventEmitter();
      child.stdin = { end: () => { stdinEnded = true; } };
      child.kill = () => {};
      return child;
    },
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, "powershell.exe");
  assert.match(spawned[0].args.at(-1), /SetThreadExecutionState\(0x80000003\)/);
  // A `uint` parameter cannot take 0x80000003 in Windows PowerShell 5.1 and silently holds nothing.
  assert.match(spawned[0].args.at(-1), /SetThreadExecutionState\(int flags\)/);
  assert.equal(stdinEnded, false);
  release();
  assert.equal(stdinEnded, true);
});
