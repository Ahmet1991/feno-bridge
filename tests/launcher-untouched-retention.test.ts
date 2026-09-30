import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

// 30.09: a reused conversation whose page could not even be acquired (browser_page timed out after
// 60 s behind a heavy parallel turn) was released, so Codex's retry resent the whole history as a
// fresh multipart conversation that ChatGPT refused at part 5, five times over. Such a turn left the
// conversation untouched and now asks the launcher to keep it for the retry.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(controlEndpoint: string): string {
  const root = mkdtempSync(join(tmpdir(), "codex-untouched-retention-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    control: { endpoint: controlEndpoint, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

async function failedLauncherTurnEnd(options: { reused: boolean; pageAcquired: boolean }): Promise<unknown> {
  let endBody: unknown;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/v1/turn/end") endBody = body;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/turn/start"
      ? `{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB","reused":${options.reused},"connectorBound":true}\n`
      : request.url === "/v1/turn/end"
        ? '{"ok":true,"cancelledByUser":false}\n'
        : '{"ok":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const acquiredLauncherPages = new Set<string>();
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: {
        browserHost: "launcher",
        browserHostDescriptorPath: descriptorFile(`http://127.0.0.1:${address.port}`),
        appName: "Codex Native2",
      },
      acquiredLauncherPages,
      runBrowserTurn: async (turn: { traceId: string }) => {
        if (options.pageAcquired) acquiredLauncherPages.add(turn.traceId);
        throw new Error("ChatGPT browser stage timed out: browser_page");
      },
    });
    const runExclusive = (ChatGptBrowserWorker.prototype as unknown as {
      runExclusive(turn: unknown): Promise<string>;
    }).runExclusive;
    await expect(runExclusive.call(worker, {
      traceId: "abc123def456",
      conversationKey: "a".repeat(64),
      nativeConnector: true,
      capabilities: { localToolsEnabled: true },
      retainConversation: true,
      prepareResume: async () => ({}),
    })).rejects.toThrow("browser_page");
    expect(acquiredLauncherPages.size).toBe(0);
    return endBody;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("a reused conversation whose page was never acquired is kept for Codex's retry (30.09)", async () => {
  expect(await failedLauncherTurnEnd({ reused: true, pageAcquired: false })).toMatchObject({
    phase: "end",
    status: "failed",
    retain: true,
    untouched: true,
  });
});

test("a failure after the page was acquired, or in a fresh tab, never keeps the conversation", async () => {
  for (const options of [{ reused: true, pageAcquired: true }, { reused: false, pageAcquired: false }]) {
    const end = await failedLauncherTurnEnd(options) as Record<string, unknown>;
    expect(end).toMatchObject({ phase: "end", status: "failed" });
    expect(end.retain).toBeUndefined();
    expect(end.untouched).toBeUndefined();
  }
});
