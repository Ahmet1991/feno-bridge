import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { resolveAllowedPath } from "../src/pc-control/paths";
import { applyPcPatch, createPcFile, createPcDirectory, listPcFiles, readPcFile } from "../src/pc-control/files";

const root = mkdtempSync(join(tmpdir(), "pc-bridge-files-"));
const outside = mkdtempSync(join(tmpdir(), "pc-bridge-other-"));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const grant = (permissions: ("files.read" | "files.write")[] = ["files.read", "files.write"]) => {
  const authorizer = new PcAuthorizer();
  authorizer.setGrantFromLocalApproval({
    id: `local-${crypto.randomUUID()}`,
    expiresAt: Date.now() + 60_000,
    roots: [root], permissions, allowedApps: [],
  });
  return authorizer;
};

afterEach(() => {
  for (const name of ["text.txt", "big.bin", "binary.bin", "link.txt", "escape", ".env", "new-script.ts", "new-dir", ".git"]) {
    rmSync(join(root, name), { force: true, recursive: true });
  }
  rmSync(join(outside, "private.txt"), { force: true });
});

describe("PC file access stays inside locally approved canonical roots", () => {
  test("denies traversal, sibling root prefix, symlink and out-of-root creation", () => {
    writeFileSync(join(outside, "private.txt"), "do not read");
    expect(() => resolveAllowedPath(join(outside, "private.txt"), [root])).toThrow("pc_access_denied");
    expect(() => resolveAllowedPath(join(root, "..", "private.txt"), [root])).toThrow("pc_access_denied");
    expect(() => resolveAllowedPath(join(outside, "new.txt"), [root], { forCreate: true })).toThrow("pc_access_denied");
    symlinkSync(join(outside, "private.txt"), join(root, "link.txt"));
    expect(() => resolveAllowedPath(join(root, "link.txt"), [root])).toThrow("pc_access_denied");
    symlinkSync(outside, join(root, "escape"), "dir");
    expect(() => resolveAllowedPath(join(root, "escape", "created.txt"), [root], { forCreate: true })).toThrow("pc_access_denied");
  });

  test("lists only a bounded directory and reads text with SHA256", async () => {
    writeFileSync(join(root, "text.txt"), "old\n");
    const authorizer = grant(["files.read"]);
    const files = await listPcFiles(root, ".", authorizer);
    expect(files).toContainEqual({ name: "text.txt", kind: "file" });
    expect(await readPcFile(join(root, "text.txt"), authorizer)).toEqual({
      path: join(root, "text.txt"), content: "old\n", sha256: sha("old\n"),
    });
    expect(() => resolveAllowedPath(join(root, "missing.txt"), [root])).toThrow("pc_access_denied");
  });

  test("rejects secret-like, binary and oversized file contents", async () => {
    writeFileSync(join(root, ".env"), "PASSWORD=secret");
    writeFileSync(join(root, "binary.bin"), Buffer.from([65, 0, 66]));
    writeFileSync(join(root, "big.bin"), "A".repeat(2 * 1024 * 1024 + 1));
    const auth = grant();
    await expect(readPcFile(join(root, ".env"), auth)).rejects.toThrow("pc_access_denied");
    await expect(readPcFile(join(root, "binary.bin"), auth)).rejects.toThrow("pc_access_denied");
    await expect(readPcFile(join(root, "big.bin"), auth)).rejects.toThrow("pc_access_denied");
  });

  test("atomic unified patch requires write permission and matching SHA", async () => {
    const file = join(root, "text.txt");
    writeFileSync(file, "first\nsecond\n");
    const patch = "@@ -1,2 +1,2 @@\n first\n-second\n+edited\n";
    await expect(applyPcPatch(file, sha("first\nsecond\n"), patch, grant(["files.read"])))
      .rejects.toThrow("pc_access_denied");
    expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");
    const auth = grant();
    await expect(applyPcPatch(file, "00".repeat(32), patch, auth)).rejects.toThrow("pc_access_denied");
    await expect(applyPcPatch(file, sha("first\nsecond\n"), "malformed patch", auth)).rejects.toThrow("pc_access_denied");
    expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");
    expect(await applyPcPatch(file, sha("first\nsecond\n"), patch, auth)).toEqual({
      path: file, newSha256: sha("first\nedited\n"),
    });
    expect(readFileSync(file, "utf8")).toBe("first\nedited\n");
  });

  test("revocation prevents writes", async () => {
    const file = join(root, "text.txt");
    writeFileSync(file, "before\n");
    const auth = grant();
    auth.revoke();
    await expect(applyPcPatch(file, sha("before\n"), "@@ -1 +1 @@\n-before\n+after\n", auth))
      .rejects.toThrow("pc_access_denied");
    expect(readFileSync(file, "utf8")).toBe("before\n");
  });

  test("creates new project files and directories without replacing existing data", async () => {
    const auth = grant();
    const dir = join(root, "new-dir");
    expect(await createPcDirectory(dir, auth)).toEqual({ path: dir });
    const file = join(dir, "new-script.ts");
    expect(await createPcFile(file, "export const answer = 42;\n", auth)).toEqual({
      path: file, sha256: sha("export const answer = 42;\n"),
    });
    expect(readFileSync(file, "utf8")).toBe("export const answer = 42;\n");
    await expect(createPcFile(file, "replace?", auth)).rejects.toThrow("pc_access_denied");
    await expect(createPcDirectory(dir, auth)).rejects.toThrow("pc_access_denied");
    expect(readFileSync(file, "utf8")).toBe("export const answer = 42;\n");
  });

  test("file creation rejects secrets, repository internals, traversal and revoked grants", async () => {
    const auth = grant();
    await expect(createPcFile(join(root, ".env"), "NOT_SECRET=ok", auth)).rejects.toThrow("pc_access_denied");
    await expect(createPcFile(join(root, "new-script.ts"), "password=mytoken", auth)).rejects.toThrow("pc_access_denied");
    await expect(createPcFile(join(outside, "new-script.ts"), "hello", auth)).rejects.toThrow("pc_access_denied");
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".git", "hooks"));
    await expect(createPcFile(join(root, ".git", "hooks", "post-commit"), "malicious", auth)).rejects.toThrow("pc_access_denied");
    auth.revoke();
    await expect(createPcFile(join(root, "new-script.ts"), "ok", auth)).rejects.toThrow("pc_access_denied");
    await expect(createPcDirectory(join(root, "new-dir"), auth)).rejects.toThrow("pc_access_denied");
  });
});
