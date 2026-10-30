import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const { createPcConsentChannel } = require("../launcher/electron/pc-consent-channel.cjs");

test("native MCP uses signed local PC consent without a Codex turn and preserves the Codex token boundary", async () => {
  const home = mkdtempSync(join(tmpdir(), "akentek-pc-e2e-"));
  const runtime = join(home, "runtime");
  const project = join(home, "project");
  mkdirSync(runtime);
  mkdirSync(project);
  const file = join(project, "example.txt");
  writeFileSync(file, "old\n");
  const writer = createPcConsentChannel({ directory: runtime });
  writer.start();
  const client = new Client({ name: "pc-e2e-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", join(runtime, "nonexistent-broker.sock")],
    cwd: process.cwd(),
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home },
    stderr: "pipe",
  });
  let childErrors = "";
  transport.stderr?.on("data", (chunk: Buffer) => { childErrors += chunk.toString("utf8").slice(0, 2000); });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain("pc_status");
    expect(names).toContain("codex_exec");
    expect((await client.callTool({ name: "pc_status", arguments: {} })).structuredContent).toMatchObject({ enabled: false });
    expect((await client.callTool({ name: "pc_read_file", arguments: { path: file } })).isError).toBeTrue();

    writer.activate({ id: `local-${crypto.randomUUID()}`, expiresAt: Date.now() + 60_000,
      roots: [project], permissions: ["status", "files.read", "files.write"], allowedApps: [] });
    const active = await client.callTool({ name: "pc_status", arguments: {} });
    expect(active.structuredContent).toMatchObject({ enabled: true });
    const read = await client.callTool({ name: "pc_read_file", arguments: { path: file } });
    expect(read.isError).toBeFalsy();
    expect(JSON.stringify(read.structuredContent)).toContain("old");
    const written = await client.callTool({ name: "pc_write_patch", arguments: {
      path: file,
      sha256: createHash("sha256").update("old\n").digest("hex"),
      patch: "@@ -1 +1 @@\n-old\n+new\n",
    } });
    expect(written.isError).toBeFalsy();
    expect(readFileSync(file, "utf8")).toBe("new\n");
    const invalidCodex = await client.callTool({ name: "codex_exec", arguments: { cmd: "echo should-not-run" } });
    expect(invalidCodex.isError).toBeTrue();

    writer.revoke();
    expect((await client.callTool({ name: "pc_read_file", arguments: { path: file } })).isError).toBeTrue();
    expect((await client.callTool({ name: "pc_status", arguments: {} })).structuredContent).toMatchObject({ enabled: false });
  } catch (error) {
    throw new Error(`MCP e2e failed: ${String(error)}; child stderr: ${childErrors.slice(0, 2000)}`);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
