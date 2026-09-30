import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptTurnSupersededError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptAttachmentLimitError, ChatGptBrowserWorker, waitForChatGptGenerationStopped } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

// 30.09: two ways a retained ChatGPT conversation used to be dropped and then resent in full.
// (1) A reused conversation whose page could not even be acquired (browser_page timed out after 60 s
// behind a heavy parallel turn) was released; Codex's retries resent the whole history as a fresh
// multipart conversation that ChatGPT refused at part 5, five times over.
// (2) A steering message superseded the running response; its conversation was released and the
// steered request resent the whole history (6 parts, 112 s of silence before the model answered).

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

interface TurnScenario {
  reused: boolean;
  pageAcquired: boolean;
  sendStarted?: boolean;
  cleanlyStopped?: boolean;
  /** Abort the turn with this reason instead of failing it at browser_page. */
  abort?: "superseded" | "plain";
  /** Fail with this error instead of the browser_page timeout. */
  failure?: Error;
}

async function launcherTurnEnd(scenario: TurnScenario): Promise<Record<string, unknown>> {
  let endBody: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/v1/turn/end") endBody = body;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/turn/start"
      ? `{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB","reused":${scenario.reused},"connectorBound":true}\n`
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
    const launcherSendStarted = new Set<string>();
    const cleanlyStoppedLauncherTurns = new Set<string>();
    const abort = new AbortController();
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: {
        browserHost: "launcher",
        browserHostDescriptorPath: descriptorFile(`http://127.0.0.1:${address.port}`),
        appName: "Codex Native2",
      },
      acquiredLauncherPages,
      launcherSendStarted,
      cleanlyStoppedLauncherTurns,
      runBrowserTurn: async (turn: { traceId: string }) => {
        if (scenario.pageAcquired) acquiredLauncherPages.add(turn.traceId);
        if (scenario.sendStarted) launcherSendStarted.add(turn.traceId);
        if (scenario.cleanlyStopped) cleanlyStoppedLauncherTurns.add(turn.traceId);
        if (scenario.abort) {
          abort.abort(scenario.abort === "superseded" ? chatGptTurnSupersededError() : undefined);
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        throw scenario.failure ?? new Error("ChatGPT browser stage timed out: browser_page");
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
      abortSignal: abort.signal,
    })).rejects.toThrow(scenario.abort ? "aborted" : scenario.failure?.message ?? "browser_page");
    expect(acquiredLauncherPages.size + launcherSendStarted.size + cleanlyStoppedLauncherTurns.size).toBe(0);
    return endBody!;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("a reused conversation whose page was never acquired is kept for Codex's retry (30.09)", async () => {
  expect(await launcherTurnEnd({ reused: true, pageAcquired: false })).toMatchObject({
    phase: "end",
    status: "failed",
    retain: true,
    untouched: true,
  });
});

test("a failure after the page was acquired, or in a fresh tab, never keeps the conversation", async () => {
  for (const scenario of [{ reused: true, pageAcquired: true }, { reused: false, pageAcquired: false }]) {
    const end = await launcherTurnEnd(scenario);
    expect(end).toMatchObject({ phase: "end", status: "failed" });
    expect(end.retain).toBeUndefined();
    expect(end.untouched).toBeUndefined();
  }
});

test("a steered response that stopped cleanly keeps its conversation for the steered request (30.09)", async () => {
  for (const scenario of [
    { reused: false, pageAcquired: true, sendStarted: true, cleanlyStopped: true, abort: "superseded" as const },
    { reused: true, pageAcquired: true, sendStarted: false, abort: "superseded" as const },
  ]) {
    expect(await launcherTurnEnd(scenario)).toMatchObject({
      phase: "end",
      status: "aborted",
      retain: true,
      superseded: true,
      connectorBound: true,
    });
  }
});

test("steering keeps no conversation that is not clean, and an ordinary abort keeps none", async () => {
  for (const scenario of [
    // The response was sending or still generating when the steer arrived.
    { reused: true, pageAcquired: true, sendStarted: true, cleanlyStopped: false, abort: "superseded" as const },
    // A fresh tab where nothing was ever sent has no conversation to continue.
    { reused: false, pageAcquired: true, sendStarted: false, abort: "superseded" as const },
    { reused: true, pageAcquired: false, abort: "superseded" as const },
    // The user stopped the turn; that is not steering.
    { reused: true, pageAcquired: true, sendStarted: true, cleanlyStopped: true, abort: "plain" as const },
  ]) {
    const end = await launcherTurnEnd(scenario);
    expect(end).toMatchObject({ phase: "end", status: "aborted" });
    expect(end.retain).toBeUndefined();
    expect(end.superseded).toBeUndefined();
  }
});

test("an attachment limit met before anything was sent keeps the reused conversation (30.09)", async () => {
  // Live: an image continuation met ChatGPT's file attachment limit and its conversation was
  // dropped, so the fallback turn found it "no longer available".
  const limit = new ChatGptAttachmentLimitError("Dosya eki limitine ulaştın 30 Eyl 21:45 sonra tekrar dene");
  expect(await launcherTurnEnd({ reused: true, pageAcquired: true, sendStarted: false, failure: limit })).toMatchObject({
    phase: "end",
    status: "failed",
    retain: true,
    untouched: true,
  });
  // Once sending started, or for any other failure after the page was acquired, it is released.
  for (const scenario of [
    { reused: true, pageAcquired: true, sendStarted: true, failure: limit },
    { reused: true, pageAcquired: true, sendStarted: false, failure: new Error("ChatGPT did not accept all prompt attachments") },
  ]) {
    const end = await launcherTurnEnd(scenario);
    expect(end.retain).toBeUndefined();
    expect(end.untouched).toBeUndefined();
  }
});

test("a stopped response is clean only once its Stop control is gone", async () => {
  const visibility = [true, true, false];
  const page = { locator: () => ({ last: () => ({ isVisible: async () => visibility.shift() ?? false }) }) };
  expect(await waitForChatGptGenerationStopped(page as never, 2_000, 1)).toBeTrue();
  const stuck = { locator: () => ({ last: () => ({ isVisible: async () => true }) }) };
  expect(await waitForChatGptGenerationStopped(stuck as never, 20, 1)).toBeFalse();
});

test("a conversation whose only response was stopped during agent activity is still recognized (30.09)", async () => {
  // Live on DEV: steering stopped the first response while it ran a tool. The new app shell shows
  // that response as an agent activity block with no answer unit, and the retained check read the
  // page as empty, so the steered request fell back to resending the whole history.
  const assertRetainedConversation = (ChatGptBrowserWorker.prototype as unknown as {
    assertRetainedConversation(page: unknown, turn: unknown, moment: string, expectedPath?: string): Promise<string>;
  }).assertRetainedConversation;
  const page = {
    url: () => "https://chatgpt.com/c/6abc309d-db8c-83eb-b94e-161ee410b9bb?temporary-chat=true",
    locator: (selector: string) => ({
      count: async () => (selector.includes("[data-chatgpt-agent-turn-start]") ? 1 : 0),
    }),
  };
  await expect(assertRetainedConversation.call(
    Object.create(ChatGptBrowserWorker.prototype),
    page,
    { traceId: "abc123def456" },
    "before_turn",
  )).resolves.toBe("/c/6abc309d-db8c-83eb-b94e-161ee410b9bb");
});
