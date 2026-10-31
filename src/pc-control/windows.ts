import { spawn } from "node:child_process";
import { join } from "node:path";
import { PcAccessDeniedError, PcAuthorizer } from "./authorization";
import { getConfigDir } from "../config";

type PcWindow = { id: string; title: string; processName: string };
type PcHelperAction = "session" | "list" | "capture" | "click" | "right_click" | "scroll" | "key" | "type";
export type PcDesktopInput = { windowId: string; action: "click" | "right_click" | "scroll" | "key" | "type";
  x?: number; y?: number; delta?: number; key?: string; text?: string };
export type PcWindowsHelper = (action: PcHelperAction, args: Record<string, unknown>) => Promise<unknown>;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SCREEN_BYTES = 6 * 1024 * 1024;
const KEYS = new Set(["ENTER", "ESC", "TAB", "SPACE", "BACKSPACE", "DELETE", "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "PAGEUP", "PAGEDOWN",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "CTRL+A", "CTRL+C", "CTRL+F", "CTRL+L", "CTRL+N", "CTRL+P", "CTRL+S", "CTRL+T", "CTRL+V", "CTRL+W", "CTRL+X", "CTRL+Y", "CTRL+Z",
  "CTRL+SHIFT+P", "ALT+LEFT", "ALT+RIGHT"]);

async function packagedWindowsHelper(action: PcHelperAction, args: Record<string, unknown>): Promise<unknown> {
  if (process.platform !== "win32") throw new PcAccessDeniedError();
  const script = join(getConfigDir(), "runtime", "pc-windows-helper.ps1");
  const payload = Buffer.from(JSON.stringify({ action, args }), "utf8").toString("base64");
  return new Promise((resolve, reject) => {
  const windowsSystem = process.env.SystemRoot || "C:\\Windows";
  const powershell = join(windowsSystem, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-PayloadBase64", payload], {
      windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => { child.kill(); fail(); }, 12_000);
    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PcAccessDeniedError());
    }
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 11 * 1024 * 1024) { child.kill(); fail(); return; }
      chunks.push(chunk);
    });
    child.once("error", fail);
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error("helper failure");
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch { reject(new PcAccessDeniedError()); }
    });
  });
}

export function createPcWindowsController(options: {
  authorizer: PcAuthorizer;
  runHelper?: PcWindowsHelper;
  isInteractive?: () => Promise<boolean>;
}) {
  const { authorizer } = options;
  const helper = options.runHelper ?? packagedWindowsHelper;
  const interactive = options.isInteractive ?? (async () => {
    const result = await helper("session", {});
    return !!result && typeof result === "object" && (result as { unlocked?: unknown }).unlocked === true;
  });

  async function assertInteractive(permission: "screen.read" | "desktop.input") {
    authorizer.assert(permission);
    if (!(await interactive())) throw new PcAccessDeniedError();
    authorizer.assert(permission);
  }

  async function windows(permission: "screen.read" | "desktop.input"): Promise<PcWindow[]> {
    await assertInteractive(permission);
    const allowed = authorizer.assert(permission).allowedApps.map(app => app.toLowerCase());
    if (!allowed.length) return [];
    const raw = await helper("list", {});
    if (!Array.isArray(raw) || raw.length > 300) throw new PcAccessDeniedError();
    return raw.filter((window): window is PcWindow => window && typeof window === "object"
      && typeof window.id === "string" && /^[1-9][0-9]{0,15}$/.test(window.id)
      && typeof window.title === "string" && window.title.length <= 512
      && typeof window.processName === "string" && allowed.includes(window.processName.toLowerCase()));
  }

  async function assertWindow(windowId: string, permission: "screen.read" | "desktop.input"): Promise<PcWindow> {
    if (typeof windowId !== "string" || !/^[1-9][0-9]{0,15}$/.test(windowId)) throw new PcAccessDeniedError();
    const available = await windows(permission);
    const selected = available.find(window => window.id === windowId);
    if (!selected) throw new PcAccessDeniedError();
    authorizer.assert(permission);
    return selected;
  }

  return {
    listPcWindows: async () => windows("screen.read"),
    async capturePcWindow(id: string): Promise<{ mimeType: "image/png"; data: Uint8Array }> {
      const selected = await assertWindow(id, "screen.read");
      const raw = await helper("capture", { windowId: id, processName: selected.processName, title: selected.title });
      if (!raw || typeof raw !== "object" || (raw as { mimeType?: unknown }).mimeType !== "image/png"
        || typeof (raw as { base64?: unknown }).base64 !== "string") throw new PcAccessDeniedError();
      const bytes = Buffer.from((raw as { base64: string }).base64, "base64");
      if (bytes.length < PNG_MAGIC.length || bytes.length > MAX_SCREEN_BYTES || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
        throw new PcAccessDeniedError();
      }
      authorizer.assert("screen.read");
      return { mimeType: "image/png", data: bytes };
    },
    async pcDesktopInput(input: PcDesktopInput): Promise<{ ok: true }> {
      if (!input || typeof input !== "object") throw new PcAccessDeniedError();
      let args: Record<string, unknown>;
      switch (input.action) {
        case "click":
        case "right_click":
          if (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y)
            || input.x! < 0 || input.y! < 0 || input.x! > 8192 || input.y! > 8192) throw new PcAccessDeniedError();
          args = { windowId: input.windowId, x: input.x, y: input.y };
          break;
        case "scroll":
          if (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y)
            || input.x! < 0 || input.y! < 0 || input.x! > 8192 || input.y! > 8192
            || !Number.isSafeInteger(input.delta) || !input.delta || Math.abs(input.delta) > 1_080) throw new PcAccessDeniedError();
          args = { windowId: input.windowId, x: input.x, y: input.y, delta: input.delta };
          break;
        case "key":
          if (!input.key || !KEYS.has(input.key)) throw new PcAccessDeniedError();
          args = { windowId: input.windowId, key: input.key };
          break;
        case "type":
          if (!input.text || input.text.length > 300 || !/^[\p{L}\p{N} .,_@:/!?()\-]+$/u.test(input.text)) throw new PcAccessDeniedError();
          args = { windowId: input.windowId, text: input.text };
          break;
        default:
          throw new PcAccessDeniedError();
      }
      const selected = await assertWindow(input.windowId, "desktop.input");
      const response = await helper(input.action, { ...args, processName: selected.processName, title: selected.title });
      if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) throw new PcAccessDeniedError();
      authorizer.assert("desktop.input");
      return { ok: true };
    },
  };
}
