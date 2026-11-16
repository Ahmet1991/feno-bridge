import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PcAccessDeniedError, PcAuthorizer } from "./authorization";
import { PcOperationError, invalidPcArgument } from "./errors";

type PcWindow = { id: string; title: string; processName: string };
type PcHelperAction = "session" | "list" | "capture" | "full" | "activate" | "click" | "right_click" | "double_click" | "drag" | "scroll" | "key" | "type" | "clipboard_read" | "clipboard_write";
export type PcDesktopInput = { windowId: string; action: "click" | "right_click" | "double_click" | "drag" | "scroll" | "key" | "type";
  x?: number; y?: number; endX?: number; endY?: number; delta?: number; key?: string; text?: string };
export type PcWindowsHelper = (action: PcHelperAction, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SCREEN_BYTES = 6 * 1024 * 1024;
export const PC_DESKTOP_KEYS = ["ENTER", "ESC", "TAB", "SPACE", "BACKSPACE", "DELETE", "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "PAGEUP", "PAGEDOWN",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "CTRL+A", "CTRL+C", "CTRL+F", "CTRL+L", "CTRL+N", "CTRL+P", "CTRL+S", "CTRL+T", "CTRL+V", "CTRL+W", "CTRL+X", "CTRL+Y", "CTRL+Z",
  "CTRL+END", "CTRL+HOME", "CTRL+SHIFT+P", "CTRL+SHIFT+S", "ALT+LEFT", "ALT+RIGHT", "ALT+F4", "SHIFT+TAB"] as const;
// Browser tab navigation and numbered tabs are part of the published contract.
// Keep the helper's KeyNames/VirtualKeys in sync with this list.
export const PC_ADDITIONAL_KEYS = ["CTRL+SHIFT+TAB", ...Array.from({length:9},(_,i)=>`CTRL+${i+1}`)] as const;
const KEYS = new Set<string>([...PC_DESKTOP_KEYS,...PC_ADDITIONAL_KEYS]);
export function normalizePcDesktopKey(key:unknown):string {
  if(typeof key!=='string')throw invalidPcArgument('key','Expected a key name',PC_DESKTOP_KEYS);
  const value=key.replace(/\s+/g,'').toUpperCase().replace(/^CONTROL\+/,'CTRL+');
  const normalized=({ESCAPE:'ESC',RETURN:'ENTER',PGUP:'PAGEUP',PGDN:'PAGEDOWN'} as Record<string,string>)[value]??value;
  if(!KEYS.has(normalized))throw invalidPcArgument('key','Unsupported key or shortcut',[...KEYS]);
  return normalized;
}

type VerifiedHelperPaths = { executablePath: string; manifestPath: string };
type VerifiedHelperOptions = VerifiedHelperPaths & { spawnHelper?: typeof spawn };
// The launcher supplies the packaged application's resource directory. A standalone CLI
// cannot silently fall back to the writable profile's copied Bun runtime.
const defaultHelperPaths = (): VerifiedHelperPaths => {
  const root = process.env.FENO_PC_HELPER_ROOT;
  if (!root || !isAbsolute(root)) return { executablePath: "", manifestPath: "" };
  return {
    executablePath: join(root, "pc-windows-helper.exe"),
    manifestPath: join(root, "pc-windows-helper.sha256"),
  };
};

function verifyHelper(paths: VerifiedHelperPaths): void {
  let info;
  try { info = lstatSync(paths.executablePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PcOperationError("pc_helper_missing");
    throw new PcOperationError("pc_helper_untrusted");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 20 * 1024 * 1024)
    throw new PcOperationError("pc_helper_untrusted");
  try {
    const signature = readFileSync(paths.manifestPath, "utf8");
    if (!/^[a-f0-9]{64}\r?\n?$/.test(signature)) throw Error("invalid manifest");
    const actual = createHash("sha256").update(readFileSync(paths.executablePath)).digest("hex");
    if (actual !== signature.trim()) throw Error("helper hash mismatch");
  } catch { throw new PcOperationError("pc_helper_untrusted"); }
}

export function pcWindowsHelperStatus(paths: VerifiedHelperPaths = defaultHelperPaths()):
  { available: true } | { available: false; reason: "pc_helper_missing" | "pc_helper_untrusted" } {
  try { verifyHelper(paths); return { available: true }; }
  catch (error) {
    return { available: false, reason: error instanceof PcOperationError ? error.code as "pc_helper_missing" | "pc_helper_untrusted" : "pc_helper_untrusted" };
  }
}

export function createVerifiedWindowsHelper(options: VerifiedHelperOptions): PcWindowsHelper {
  const { executablePath, manifestPath, spawnHelper = spawn } = options;
  return async (action, args, signal) => {
  if (signal?.aborted) throw new PcAccessDeniedError();
  const inputBytes=Buffer.from(JSON.stringify({ action, args }), "utf8");
  const usingStdin=action==='clipboard_write';
  const payload=inputBytes.toString('base64');
  return new Promise((resolve, reject) => {
    // Synchronous verify immediately before spawn, once per invocation. No async gap.
    try { verifyHelper({ executablePath, manifestPath }); }
    catch (error) { reject(error); return; }
    if (signal?.aborted) { reject(new PcAccessDeniedError()); return; }
    const child = spawnHelper(executablePath, usingStdin?["--stdin"]:["--payload", payload], {
      windowsHide: true, shell: false, stdio: [usingStdin?"pipe":"ignore", "pipe", "pipe"],
    });
    if(usingStdin)child.stdin?.end(inputBytes);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let aborted=false;
    const cancel = () => { aborted=true; child.kill(); };
    const timer = setTimeout(cancel, 12_000);
    signal?.addEventListener('abort', cancel, {once:true});
    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new PcAccessDeniedError());
    }
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 11 * 1024 * 1024) { cancel(); return; }
      chunks.push(chunk);
    });
    child.once("error", fail);
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      try {
        if (aborted||signal?.aborted) throw new Error('cancelled');
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (code !== 0 && !(result?.ok === false && result?.reason === "focus_required"
          && ["activate","click", "right_click", "double_click", "drag", "scroll", "key", "type"].includes(action))) throw new Error("helper failure");
        resolve(result);
      } catch { reject(new PcAccessDeniedError()); }
    });
  });
  };
}

async function packagedWindowsHelper(action: PcHelperAction, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (process.platform !== "win32") throw new PcAccessDeniedError();
  return createVerifiedWindowsHelper(defaultHelperPaths())(action, args, signal);
}
export const invokePackagedWindowsHelper:PcWindowsHelper=packagedWindowsHelper;

export function createPcWindowsController(options: {
  authorizer: PcAuthorizer;
  runHelper?: PcWindowsHelper;
  isInteractive?: () => Promise<boolean>;
  signal?: AbortSignal;
}) {
  const { authorizer } = options;
  const helper = options.runHelper ?? packagedWindowsHelper;
  const guard=(permission:'screen.read'|'screen.full'|'desktop.input'|'desktop.advanced',expected?:string)=>{
    if(options.signal?.aborted)throw new PcAccessDeniedError();
    const grant=authorizer.assert(permission);
    if(expected && grant.id!==expected)throw new PcAccessDeniedError();
    return grant;
  };
  const interactive = options.isInteractive ?? (async () => {
    const result = await helper("session", {}, options.signal);
    return !!result && typeof result === "object" && (result as { unlocked?: unknown }).unlocked === true;
  });

  async function assertInteractive(permission: "screen.read" | "desktop.input") {
    const id=guard(permission).id;
    if (!(await interactive())) throw new PcAccessDeniedError();
    guard(permission,id);
  }

  async function windows(permission: "screen.read" | "desktop.input"): Promise<PcWindow[]> {
    await assertInteractive(permission);
    const id=guard(permission).id;
    const scope=authorizer.assert(permission);
    const allowed = scope.allowedApps.map(app => app.toLowerCase());
    if (!scope.fullAccess&&!allowed.length) return [];
    const raw = await helper("list", {}, options.signal);
    guard(permission,id);
    if (!Array.isArray(raw) || raw.length > 300) throw new PcAccessDeniedError();
    return raw.filter((window): window is PcWindow => window && typeof window === "object"
      && typeof window.id === "string" && /^[1-9][0-9]{0,15}$/.test(window.id)
      && typeof window.title === "string" && window.title.length <= 512
      && typeof window.processName === "string" && (scope.fullAccess||allowed.includes(window.processName.toLowerCase())));
  }

  async function assertWindow(windowId: string, permission: "screen.read" | "desktop.input"): Promise<PcWindow> {
    if (typeof windowId !== "string" || !/^[1-9][0-9]{0,15}$/.test(windowId)) throw new PcAccessDeniedError();
    const available = await windows(permission);
    const selected = available.find(window => window.id === windowId);
    if (!selected) throw new PcAccessDeniedError();
    guard(permission);
    return selected;
  }

  return {
    listPcWindows: async () => windows("screen.read"),
    async clipboardRead():Promise<{text:string}> {
      const grant=guard('desktop.input');if(!authorizer.assert('desktop.input').fullAccess)throw new PcAccessDeniedError();
      if(!(await interactive()))throw new PcAccessDeniedError();guard('desktop.input',grant.id);
      const raw=await helper('clipboard_read',{},options.signal);
      if(!raw||typeof raw!=='object'||typeof (raw as {text?:unknown}).text!=='string'
        ||Buffer.byteLength((raw as {text:string}).text,'utf8')>65536)throw new PcAccessDeniedError();
      guard('desktop.input',grant.id);return {text:(raw as {text:string}).text};
    },
    async clipboardWrite(text:string):Promise<{ok:true}> {
      if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>65536||text.includes('\0'))
        throw invalidPcArgument('text','Clipboard text must be at most 65536 UTF-8 bytes');
      const grant=guard('desktop.input');if(!authorizer.assert('desktop.input').fullAccess)throw new PcAccessDeniedError();
      if(!(await interactive()))throw new PcAccessDeniedError();guard('desktop.input',grant.id);
      const result=await helper('clipboard_write',{text},options.signal);
      if(!result||typeof result!=='object'||(result as {ok?:unknown}).ok!==true)throw new PcAccessDeniedError();
      guard('desktop.input',grant.id);return {ok:true};
    },
    async capturePcWindow(id: string): Promise<{ mimeType: "image/png"; data: Uint8Array }> {
      const selected = await assertWindow(id, "screen.read");
      const grantId=guard('screen.read').id;
      const raw = await helper("capture", { windowId: id, processName: selected.processName, title: selected.title }, options.signal);
      if (!raw || typeof raw !== "object" || (raw as { mimeType?: unknown }).mimeType !== "image/png"
        || typeof (raw as { base64?: unknown }).base64 !== "string") throw new PcAccessDeniedError();
      const bytes = Buffer.from((raw as { base64: string }).base64, "base64");
      if (bytes.length < PNG_MAGIC.length || bytes.length > MAX_SCREEN_BYTES || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
        throw new PcAccessDeniedError();
      }
      guard("screen.read",grantId);
      return { mimeType: "image/png", data: bytes };
    },
    async captureFull(mode:'all'|'monitor',monitor?:number):Promise<{mimeType:'image/png';data:Uint8Array}> {
      const id=guard('screen.full').id;
      if(!['all','monitor'].includes(mode)||mode==='monitor'&&(!Number.isSafeInteger(monitor)||monitor!<0||monitor!>7)
        ||mode==='all'&&monitor!==undefined)throw new PcAccessDeniedError();
      if(!(await interactive()))throw new PcAccessDeniedError();
      guard('screen.full',id);
      const raw=await helper('full',{mode,...(mode==='monitor'?{monitor}:{})},options.signal);
      if(!raw||typeof raw!=='object'||(raw as {mimeType?:unknown}).mimeType!=='image/png'
        ||typeof (raw as {base64?:unknown}).base64!=='string')throw new PcAccessDeniedError();
      const bytes=Buffer.from((raw as {base64:string}).base64,'base64');
      if(bytes.length<PNG_MAGIC.length||bytes.length>MAX_SCREEN_BYTES||!bytes.subarray(0,8).equals(PNG_MAGIC))throw new PcAccessDeniedError();
      guard('screen.full',id);return {mimeType:'image/png',data:bytes};
    },
    async pcDesktopInput(input: PcDesktopInput): Promise<{ ok: true }> {
      if (!input || typeof input !== "object") throw invalidPcArgument('input','Expected desktop input object');
      const permission=input.action==='double_click'||input.action==='drag'?'desktop.advanced':'desktop.input';
      const id=guard(permission).id;
      // Advanced actions require both the base input permission and a separate local opt-in.
      guard('desktop.input');
      let args: Record<string, unknown>;
      switch (input.action) {
        case "click":
        case "right_click":
        case "double_click":
        case "drag":
          if (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y)
            || input.x! < 0 || input.y! < 0 || input.x! > 8192 || input.y! > 8192) throw invalidPcArgument('x/y','Coordinates must be between 0 and 8192');
          args = { windowId: input.windowId, x: input.x, y: input.y };
          if(input.action==='drag'){
            if(!Number.isSafeInteger(input.endX)||!Number.isSafeInteger(input.endY)||input.endX!<0||input.endY!<0
              ||input.endX!>8192||input.endY!>8192)throw invalidPcArgument('endX/endY','Drag destination must be between 0 and 8192');
            args.endX=input.endX;args.endY=input.endY;
          }
          break;
        case "scroll":
          if (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y)
            || input.x! < 0 || input.y! < 0 || input.x! > 8192 || input.y! > 8192
            || !Number.isSafeInteger(input.delta) || !input.delta || Math.abs(input.delta) > 1_080) throw invalidPcArgument('delta/x/y','Scroll requires coordinates and nonzero delta (max 1080)');
          args = { windowId: input.windowId, x: input.x, y: input.y, delta: input.delta };
          break;
        case "key":
          args = { windowId: input.windowId, key: normalizePcDesktopKey(input.key) };
          break;
        case "type":
          if (typeof input.text!=='string' || input.text.length<1 || input.text.length>300 ||
            !(authorizer.assert('desktop.input').fullAccess
              ? !/[\x00-\x1f\x7f]/u.test(input.text)
              : /^[\p{L}\p{N} .,_@:/!?()\-—]+$/u.test(input.text)))
            throw invalidPcArgument('text','Expected 1-300 safe characters');
          args = { windowId: input.windowId, text: input.text };
          break;
        default:
          throw invalidPcArgument('action','Unsupported desktop action',['click','right_click','double_click','drag','scroll','key','type']);
      }
      const selected = await assertWindow(input.windowId, "desktop.input");
      guard(permission,id);
      const response = await helper(input.action, { ...args, processName: selected.processName, title: selected.title,
        allowNonClient:authorizer.assert('desktop.input').fullAccess===true,
        allowFocus:authorizer.assert('desktop.input').fullAccess===true },options.signal);
      if (response && typeof response === "object" && (response as { ok?: unknown }).ok === false
        && (response as { reason?: unknown }).reason === "focus_required") throw new PcOperationError("pc_focus_required");
      if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) throw new PcAccessDeniedError();
      guard(permission,id);
      guard('desktop.input');
      return { ok: true };
    },
  };
}
