import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { registerPcTools, type PcHost } from "../src/pc-control/mcp-tools";

test("independent PC tools expose disabled status without Codex token and reject all other calls", async () => {
  const policy = new PcAuthorizer();
  let called = 0;
  const host: PcHost = {
    status: async () => ({ machine: "test-host" }),
    listFiles: async () => { called++; return []; },
    readFile: async () => { called++; return {}; },
    applyPatch: async () => { called++; return {}; },
  };
  const server = new McpServer({ name: "pc-contract-test", version: "1" });
  registerPcTools(server, { authorizer: policy, host });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "pc-test-client", version: "1" });
  try {
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual([
      "pc_status", "pc_list_files", "pc_read_file", "pc_write_patch",
      "pc_start_job", "pc_job_status", "pc_job_logs", "pc_cancel_job", "pc_runner_status",
      "pc_list_windows", "pc_capture_screen", "pc_desktop_input", "pc_adb_devices", "pc_adb_input", "pc_adb_screencap",
    ]);
    const status = await client.callTool({ name: "pc_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ enabled: false });
    const targets = [
      { name: "pc_list_files", arguments: { path: "/tmp/test-project" } },
      { name: "pc_read_file", arguments: { path: "/tmp/test-project/file.txt" } },
      { name: "pc_write_patch", arguments: { path: "/tmp/test-project/file.txt", sha256: "ab".repeat(32), patch: "@@ -1 +1 @@\n-old\n+new\n" } },
    ];
    for (const target of targets) {
      const denied = await client.callTool(target);
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("pc_access_denied");
    }
    expect(called).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("desktop and ADB tool calls are gated and screen bytes are returned as MCP images", async () => {
  const policy = new PcAuthorizer();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const host: PcHost = {
    status: async () => ({}), listFiles: async () => [], readFile: async () => ({}), applyPatch: async () => ({}),
    listWindows: async () => [{ id: "101", title: "Editor", processName: "notepad.exe" }],
    captureScreen: async () => ({ mimeType: "image/png", data: png }),
    desktopInput: async () => ({ ok: true }),
    adbDevices: async () => [{ serial: "emulator-5554", state: "device" }],
    adbInput: async () => ({ ok: true }),
    adbScreencap: async () => png,
  };
  const server = new McpServer({ name: "pc-gui-test", version: "1" });
  registerPcTools(server, { authorizer: policy, host });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "client", version: "1" });
  try {
    await client.connect(ct);
    expect((await client.callTool({ name: "pc_list_windows", arguments: {} })).isError).toBeTrue();
    policy.setGrantFromLocalApproval({ id: "local-gui-mcp-grant", expiresAt: Date.now() + 60_000, roots: [],
      permissions: ["screen.read", "desktop.input", "adb"], allowedApps: ["notepad.exe"] });
    expect((await client.callTool({ name: "pc_list_windows", arguments: {} })).isError).toBeFalsy();
    const screen = await client.callTool({ name: "pc_capture_screen", arguments: { windowId: "101" } });
    expect(screen.content).toContainEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    expect((await client.callTool({ name: "pc_adb_devices", arguments: {} })).isError).toBeFalsy();
    const adbScreen = await client.callTool({ name: "pc_adb_screencap", arguments: { serial: "emulator-5554" } });
    expect(adbScreen.content).toContainEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  } finally { await client.close(); await server.close(); }
});

test("job and runner tools require local approval, never accept an arbitrary command", async () => {
  const policy = new PcAuthorizer();
  const calls: string[] = [];
  const host: PcHost = {
    status: async () => ({}), listFiles: async () => [], readFile: async () => ({}), applyPatch: async () => ({}),
    startJob: async (kind, root) => { calls.push(`${kind}:${root}`); return { jobId: "job-1" }; },
    jobStatus: async () => ({ state: "running" }),
    jobLogs: async () => ({ lines: [], nextCursor: 0 }),
    cancelJob: async () => ({ ok: true }),
    runnerStatus: async () => ({ state: "online", source: "fixture" }),
  };
  const server = new McpServer({ name: "pc-jobs", version: "1" });
  registerPcTools(server, { authorizer: policy, host });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "client", version: "1" });
  try {
    await client.connect(clientTransport);
    expect((await client.callTool({ name: "pc_start_job", arguments: { kind: "typecheck", projectRoot: "/tmp/project" } })).isError).toBeTrue();
    policy.setGrantFromLocalApproval({ id: "local-job-mcp-grant", expiresAt: Date.now() + 60_000,
      roots: ["/tmp/project"], permissions: ["jobs", "runner"], allowedApps: [] });
    const result = await client.callTool({ name: "pc_start_job", arguments: { kind: "typecheck", projectRoot: "/tmp/project" } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual(["typecheck:/tmp/project"]);
    expect((await client.callTool({ name: "pc_start_job", arguments: { kind: "bash", projectRoot: "/tmp/project", command: "echo hacked" } })).isError).toBeTrue();
    expect((await client.callTool({ name: "pc_runner_status", arguments: { label: "fenotip-tv" } })).isError).toBeFalsy();
    policy.revoke();
    expect((await client.callTool({ name: "pc_job_status", arguments: { jobId: "job-1" } })).isError).toBeTrue();
  } finally {
    await client.close(); await server.close();
  }
});

test("a locally issued grant permits only its requested MCP operations; revoke closes the gate", async () => {
  const policy = new PcAuthorizer();
  const calls: string[] = [];
  const host: PcHost = {
    status: async () => ({ uptime: 10 }),
    listFiles: async path => { calls.push(`list:${path}`); return [{ name: "a.txt", kind: "file" }]; },
    readFile: async path => { calls.push(`read:${path}`); return { content: "hello" }; },
    applyPatch: async () => { calls.push("patch"); return { ok: true }; },
  };
  const server = new McpServer({ name: "pc-test", version: "1" });
  registerPcTools(server, { authorizer: policy, host });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "client", version: "1" });
  try {
    await client.connect(clientTransport);
    policy.setGrantFromLocalApproval({
      id: "local-grant-for-test", expiresAt: Date.now() + 60_000,
      roots: ["/tmp/test-project"], permissions: ["files.read"], allowedApps: [],
    });
    expect((await client.callTool({ name: "pc_status", arguments: {} })).structuredContent).toMatchObject({ enabled: true });
    expect((await client.callTool({ name: "pc_list_files", arguments: { path: "/tmp/test-project" } })).isError).toBeFalsy();
    expect((await client.callTool({ name: "pc_read_file", arguments: { path: "/tmp/test-project/a.txt" } })).isError).toBeFalsy();
    const denied = await client.callTool({
      name: "pc_write_patch", arguments: { path: "/tmp/test-project/a.txt", sha256: "ab".repeat(32), patch: "unused" },
    });
    expect(denied.isError).toBeTrue();
    expect(calls).toEqual(["list:/tmp/test-project", "read:/tmp/test-project/a.txt"]);
    policy.revoke();
    expect((await client.callTool({ name: "pc_read_file", arguments: { path: "/tmp/test-project/a.txt" } })).isError).toBeTrue();
    expect(calls).toHaveLength(2);
  } finally {
    await client.close();
    await server.close();
  }
});
