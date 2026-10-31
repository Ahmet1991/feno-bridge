import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { mkdir, open, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { PcAccessDeniedError, PcAuthorizer } from "./authorization";
import { resolveAllowedPath } from "./paths";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DIR_ENTRIES = 500;
const MAX_PATCH_BYTES = 256 * 1024;
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|credentials(?:\.json)?|secret(?:s)?(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i;
const SENSITIVE_CONTENT = /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|\b(?:authorization\s*:\s*bearer|(?:api[_-]?key|private[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?\S+)/i;

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertNotSensitive(file: string): void {
  const segments = file.split(/[\\/]+/);
  if (segments.some(segment => SENSITIVE_NAME.test(segment) || segment.toLowerCase() === ".git")) {
    throw new PcAccessDeniedError();
  }
}

function validateText(bytes: Buffer): string {
  if (bytes.byteLength > MAX_TEXT_BYTES || bytes.includes(0)) throw new PcAccessDeniedError();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (SENSITIVE_CONTENT.test(text)) throw new PcAccessDeniedError();
  return text;
}

async function boundedRead(file: string): Promise<Buffer> {
  const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await fh.stat();
    if (!stats.isFile() || stats.size > MAX_TEXT_BYTES) throw new PcAccessDeniedError();
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await fh.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await fh.close();
  }
}

export async function listPcFiles(
  root: string,
  relativePath: string,
  authorizer: PcAuthorizer,
): Promise<{ name: string; kind: "file" | "directory" }[]> {
  const grant = authorizer.assert("files.read");
  if (typeof relativePath !== "string" || relativePath.length > 2048
    || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
    throw new PcAccessDeniedError();
  }
  const approvedRoot = resolveAllowedPath(root, grant.roots);
  const resolved = resolveAllowedPath(path.join(approvedRoot, relativePath), grant.roots);
  try {
    const entries = readdirSync(resolved, { withFileTypes: true });
    if (entries.length > MAX_DIR_ENTRIES) throw new PcAccessDeniedError();
    return entries.filter(item => !SENSITIVE_NAME.test(item.name) && item.name.toLowerCase() !== ".git").map(item => ({
      name: item.name,
      kind: item.isDirectory() ? "directory" as const : "file" as const,
    }));
  } catch { throw new PcAccessDeniedError(); }
}

export async function readPcFile(file: string, authorizer: PcAuthorizer): Promise<{ path: string; content: string; sha256: string }> {
  const grant = authorizer.assert("files.read");
  const resolved = resolveAllowedPath(file, grant.roots);
  assertNotSensitive(resolved);
  try {
    const bytes = await boundedRead(resolved);
    const content = validateText(bytes);
    authorizer.assert("files.read");
    return { path: resolved, content, sha256: sha256(bytes) };
  } catch { throw new PcAccessDeniedError(); }
}

/** Creates one file atomically, never truncating or replacing a pre-existing file. */
export async function createPcFile(
  file: string,
  content: string,
  authorizer: PcAuthorizer,
): Promise<{ path: string; sha256: string }> {
  const grant = authorizer.assert("files.write");
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new PcAccessDeniedError();
  const resolved = resolveAllowedPath(file, grant.roots, { forCreate: true });
  assertNotSensitive(resolved);
  const bytes = Buffer.from(content, "utf8");
  validateText(bytes);
  let handle;
  let created = false;
  try {
    handle = await open(resolved, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Rechecking local approval before reporting prevents success after an emergency revoke.
    authorizer.assert("files.write");
    return { path: resolved, sha256: sha256(bytes) };
  } catch {
    if (created) await unlink(resolved).catch(() => {});
    throw new PcAccessDeniedError();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** Makes one previously absent directory within an approved project root. */
export async function createPcDirectory(dir: string, authorizer: PcAuthorizer): Promise<{ path: string }> {
  const grant = authorizer.assert("files.write");
  const resolved = resolveAllowedPath(dir, grant.roots, { forCreate: true });
  assertNotSensitive(resolved);
  let created = false;
  try {
    await mkdir(resolved, { recursive: false });
    created = true;
    authorizer.assert("files.write");
    return { path: resolved };
  } catch {
    if (created) await rmdir(resolved).catch(() => {});
    throw new PcAccessDeniedError();
  }
}

function applyUnifiedHunks(original: string, patch: string): string {
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) throw new PcAccessDeniedError();
  const finalNewline = original.endsWith("\n");
  const oldLines = (finalNewline ? original.slice(0, -1) : original).split("\n");
  const patchLines = patch.replace(/\n$/, "").split("\n");
  const output: string[] = [];
  let cursor = 0;
  let index = 0;
  let hunks = 0;
  while (index < patchLines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(patchLines[index] ?? "");
    if (!header || ++hunks > 100) throw new PcAccessDeniedError();
    index++;
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2] ?? "1");
    const newCount = Number(header[4] ?? "1");
    if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newCount)
      || oldStart < 1 || oldCount < 0 || newCount < 0 || oldStart - 1 < cursor || oldStart - 1 > oldLines.length) {
      throw new PcAccessDeniedError();
    }
    output.push(...oldLines.slice(cursor, oldStart - 1));
    cursor = oldStart - 1;
    let removed = 0;
    let inserted = 0;
    while (index < patchLines.length && !patchLines[index]!.startsWith("@@ ")) {
      const line = patchLines[index++]!;
      const mark = line[0];
      const body = line.slice(1);
      if (mark === " " || mark === "-") {
        if (oldLines[cursor] !== body) throw new PcAccessDeniedError();
        cursor++;
        removed++;
      }
      if (mark === " " || mark === "+") {
        output.push(body);
        inserted++;
      }
      if (mark !== " " && mark !== "-" && mark !== "+") throw new PcAccessDeniedError();
    }
    if (removed !== oldCount || inserted !== newCount) throw new PcAccessDeniedError();
  }
  if (!hunks) throw new PcAccessDeniedError();
  output.push(...oldLines.slice(cursor));
  return output.join("\n") + (finalNewline ? "\n" : "");
}

export async function applyPcPatch(
  file: string,
  expectedSha256: string,
  patch: string,
  authorizer: PcAuthorizer,
): Promise<{ path: string; newSha256: string }> {
  const grant = authorizer.assert("files.write");
  if (typeof expectedSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(expectedSha256)
    || typeof patch !== "string") throw new PcAccessDeniedError();
  const resolved = resolveAllowedPath(file, grant.roots);
  assertNotSensitive(resolved);
  const original = await boundedRead(resolved).catch(() => { throw new PcAccessDeniedError(); });
  if (sha256(original).toLowerCase() !== expectedSha256.toLowerCase()) throw new PcAccessDeniedError();
  const previous = validateText(original);
  const replacement = applyUnifiedHunks(previous, patch);
  const newBytes = Buffer.from(replacement, "utf8");
  if (newBytes.length > MAX_TEXT_BYTES) throw new PcAccessDeniedError();
  validateText(newBytes);

  const temp = path.join(path.dirname(resolved), `.akentek-pc-${randomBytes(16).toString("hex")}.tmp`);
  let fileHandle;
  try {
    const mode = statSync(resolved).mode;
    fileHandle = await open(temp, "wx", mode);
    await fileHandle.writeFile(newBytes);
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;

    // Recheck both the canonical root and original SHA immediately before an atomic replace.
    if (resolveAllowedPath(resolved, authorizer.assert("files.write").roots) !== resolved
      || resolveAllowedPath(resolved, authorizer.assert("files.write").roots, { forCreate: true }) !== resolved
      || !existsSync(resolved) || lstatSync(resolved).isSymbolicLink()
      || statSync(resolved).size > MAX_TEXT_BYTES || sha256(readFileSync(resolved)) !== sha256(original)) {
      throw new PcAccessDeniedError();
    }
    renameSync(temp, resolved);
    return { path: resolved, newSha256: sha256(newBytes) };
  } catch {
    throw new PcAccessDeniedError();
  } finally {
    if (fileHandle) await fileHandle.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}
