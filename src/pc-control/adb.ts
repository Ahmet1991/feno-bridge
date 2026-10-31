import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { PcAccessDeniedError, PcAuthorizer } from "./authorization";

// Base64 expands ~4/3; stay comfortably below the tunnel's 10 MiB response limit.
const MAX_ADB_OUTPUT = 6 * 1024 * 1024;
const VALID_SERIAL = /^[A-Za-z0-9_.:-]{1,80}$/;
const ALLOWED_KEY = new Set([
  "KEYCODE_DPAD_UP", "KEYCODE_DPAD_DOWN", "KEYCODE_DPAD_LEFT", "KEYCODE_DPAD_RIGHT", "KEYCODE_DPAD_CENTER",
  "KEYCODE_BACK", "KEYCODE_HOME", "KEYCODE_MENU", "KEYCODE_ENTER", "KEYCODE_ESCAPE",
  "KEYCODE_MEDIA_PLAY_PAUSE", "KEYCODE_MEDIA_PLAY", "KEYCODE_MEDIA_PAUSE", "KEYCODE_MEDIA_FAST_FORWARD",
  "KEYCODE_MEDIA_REWIND", "KEYCODE_VOLUME_UP", "KEYCODE_VOLUME_DOWN", "KEYCODE_VOLUME_MUTE",
]);

/** Avoid running an unrelated `adb` executable via a process-inherited PATH. */
export function resolveTrustedAdbPath(
  environment: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const candidates = [
    environment.ANDROID_HOME,
    environment.ANDROID_SDK_ROOT,
    environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, "Android", "Sdk") : undefined,
  ];
  for (const sdk of candidates) {
    if (!sdk || !path.isAbsolute(sdk)) continue;
    const adb = path.join(sdk, "platform-tools", platform === "win32" ? "adb.exe" : "adb");
    try { if (existsSync(adb) && statSync(adb).isFile()) return adb; }
    catch { /* An absent SDK never enables an arbitrary PATH lookup. */ }
  }
  return undefined;
}

export type PcAdbInput = { action: "tap" | "key" | "text"; x?: number; y?: number; value?: string };
export type PcAdbRun = (executable: string, args: string[]) => Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>;

async function runAdb(executable: string, args: string[]): ReturnType<PcAdbRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => { child.kill(); fail(); }, 15_000);
    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PcAccessDeniedError());
    }
    child.stdout.on("data", (part: Buffer) => {
      total += part.length;
      if (total > MAX_ADB_OUTPUT) { child.kill(); fail(); return; }
      chunks.push(part);
    });
    child.stderr.on("data", (part: Buffer) => {
      if (errors.reduce((size, p) => size + p.length, 0) + part.length > 4096) return;
      errors.push(part);
    });
    child.once("error", fail);
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors) });
    });
  });
}

export function createPcAdbController(options: {
  authorizer: PcAuthorizer;
  adbPath: string;
  runCommand?: PcAdbRun;
  isEmulatorReserved?: () => boolean;
}) {
  const { authorizer } = options;
  if (!options.adbPath || typeof options.adbPath !== "string" || options.adbPath.includes("\0")) throw new PcAccessDeniedError();
  const run = options.runCommand ?? runAdb;

  async function devices(): Promise<{ serial: string; state: string }[]> {
    authorizer.assert("adb");
    const result = await run(options.adbPath, ["devices"]);
    if (result.exitCode !== 0 || result.stdout.length > 64 * 1024) throw new PcAccessDeniedError();
    authorizer.assert("adb");
    return result.stdout.toString("utf8").split(/\r?\n/).slice(1)
      .map(line => /^(\S+)\s+(device|offline|unauthorized)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => !!match && VALID_SERIAL.test(match[1]!))
      .map(match => ({ serial: match[1]!, state: match[2]! }));
  }

  async function requireDevice(serial: string): Promise<void> {
    authorizer.assert("adb");
    if (!VALID_SERIAL.test(serial) || options.isEmulatorReserved?.()) throw new PcAccessDeniedError();
    const connected = await devices();
    if (!connected.some(device => device.serial === serial && device.state === "device")) throw new PcAccessDeniedError();
    authorizer.assert("adb");
  }

  return {
    adbDevices: devices,
    async adbInput(serial: string, input: PcAdbInput): Promise<void> {
      if (!input || typeof input !== "object") throw new PcAccessDeniedError();
      let args: string[];
      switch (input.action) {
        case "tap":
          if (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y) || input.x! < 0 || input.x! > 8192
            || input.y! < 0 || input.y! > 8192) throw new PcAccessDeniedError();
          args = ["shell", "input", "tap", String(input.x), String(input.y)];
          break;
        case "key":
          if (!input.value || !ALLOWED_KEY.has(input.value)) throw new PcAccessDeniedError();
          args = ["shell", "input", "keyevent", input.value];
          break;
        case "text":
          if (!input.value || input.value.length > 150 || !/^[A-Za-z0-9 ._-]+$/.test(input.value)) throw new PcAccessDeniedError();
          args = ["shell", "input", "text", input.value.replaceAll(" ", "%s")];
          break;
        default:
          throw new PcAccessDeniedError();
      }
      await requireDevice(serial);
      const result = await run(options.adbPath, ["-s", serial, ...args]);
      if (result.exitCode !== 0) throw new PcAccessDeniedError();
      authorizer.assert("adb");
    },
    async adbScreenshot(serial: string): Promise<Uint8Array> {
      await requireDevice(serial);
      const result = await run(options.adbPath, ["-s", serial, "exec-out", "screencap", "-p"]);
      if (result.exitCode !== 0 || result.stdout.length > MAX_ADB_OUTPUT
        || result.stdout.length < 8 || !result.stdout.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new PcAccessDeniedError();
      }
      authorizer.assert("adb");
      return result.stdout;
    },
  };
}
