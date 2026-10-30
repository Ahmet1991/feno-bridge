import { expect, test } from "bun:test";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { createPcAdbController } from "../src/pc-control/adb";
import { resolveTrustedAdbPath } from "../src/pc-control/adb";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function auth() {
  const policy = new PcAuthorizer();
  policy.setGrantFromLocalApproval({ id: `adb-session-${crypto.randomUUID()}`, expiresAt: Date.now() + 60_000,
    roots: [], permissions: ["adb"], allowedApps: [] });
  return policy;
}

test("ADB uses exact argv, a previously seen device, bounded screenshots and no shell injection", async () => {
  const argv: string[][] = [];
  const controller = createPcAdbController({ authorizer: auth(), adbPath: "adb", runCommand: async (_exe, args) => {
    argv.push(args);
    if (args[0] === "devices") return { exitCode: 0, stdout: Buffer.from("List of devices attached\nemulator-5554\tdevice\n"), stderr: Buffer.alloc(0) };
    if (args.includes("screencap")) return { exitCode: 0, stdout: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), stderr: Buffer.alloc(0) };
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } });
  expect(await controller.adbDevices()).toEqual([{ serial: "emulator-5554", state: "device" }]);
  await controller.adbInput("emulator-5554", { action: "tap", x: 350, y: 200 });
  await controller.adbInput("emulator-5554", { action: "key", value: "KEYCODE_DPAD_CENTER" });
  expect((await controller.adbScreenshot("emulator-5554")).length).toBe(9);
  expect(argv).toContainEqual(["-s", "emulator-5554", "shell", "input", "tap", "350", "200"]);
  expect(argv).toContainEqual(["-s", "emulator-5554", "exec-out", "screencap", "-p"]);
  await expect(controller.adbInput("emulator-5554", { action: "text", value: "hello;rm -rf /" })).rejects.toThrow("pc_access_denied");
  await expect(controller.adbInput("unlisted-1", { action: "tap", x: 1, y: 1 })).rejects.toThrow("pc_access_denied");
});

test("ADB denies unavailable devices, invalid coordinates and oversized images", async () => {
  const controller = createPcAdbController({ authorizer: auth(), adbPath: "adb", runCommand: async (_exe, args) => {
    if (args[0] === "devices") return { exitCode: 0, stdout: Buffer.from("List of devices attached\nemulator-5554\tdevice\n"), stderr: Buffer.alloc(0) };
    const oversized = Buffer.alloc(6 * 1024 * 1024 + 1);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized);
    return { exitCode: 0, stdout: oversized, stderr: Buffer.alloc(0) };
  } });
  await expect(controller.adbInput("emulator-5554", { action: "tap", x: -1, y: 0 })).rejects.toThrow("pc_access_denied");
  await expect(controller.adbScreenshot("emulator-5554")).rejects.toThrow("pc_access_denied");
});

test("ADB executable discovery requires an existing absolute Android SDK binary", () => {
  const sdk = mkdtempSync(join(tmpdir(), "pc-adb-sdk-"));
  const tools = join(sdk, "platform-tools");
  mkdirSync(tools);
  const executable = join(tools, "adb.exe");
  writeFileSync(executable, "fixture");
  expect(resolveTrustedAdbPath({ ANDROID_HOME: sdk }, "win32")).toBe(executable);
  expect(resolveTrustedAdbPath({ ANDROID_HOME: join(sdk, "missing") }, "win32")).toBeUndefined();
});
