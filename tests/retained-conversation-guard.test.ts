import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptPersonalizationProofCache } from "../src/adapters/chatgpt-web/personalization-proof-cache";

const RETAINED = "https://chatgpt.com/c/0f3c2a91-retained?temporary-chat=true";
const RELOADED = "https://chatgpt.com/?temporary-chat=true";

// 28.09 probe: a reloaded Temporary Chat lands on an empty new chat, and the bridge then sent only
// the resumed delta there; the model could not recall anything from before.
async function runResumedTurn(options: {
  assistantTurns: number;
  reloadDuringEffort?: boolean;
  requireRetainedConversation?: boolean;
}) {
  const diagnostics = mkdtempSync(join(tmpdir(), "retained-guard-"));
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const reachedObservation = new Error("fixture reached response observation");
  const actions: string[] = [];
  let url = RETAINED;
  let assistantTurns = options.assistantTurns;
  const frame = {};
  const page = Object.assign(new EventEmitter(), {
    evaluate: async () => ({}),
    isClosed: () => false,
    mainFrame: () => frame,
    url: () => url,
    locator: () => ({ count: async () => assistantTurns }),
  });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics },
    runStage: async (_trace: string, _name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => (
      action(new AbortController().signal)
    ),
    prepareTemporaryChatSurface: async () => { actions.push("new-chat"); },
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => {
      actions.push(`effort:${effort}`);
      if (options.reloadDuringEffort) {
        // The transient model-controls retry reloads the page; ChatGPT answers with a new chat.
        url = RELOADED;
        assistantTurns = 0;
      }
      return resolveChatGptWebModelMode(model, effort, capabilities);
    },
    captureSubmissionBaseline: async () => ({}),
    attachPromptWithCompactionRetry: async () => { actions.push("attach"); },
    attachFiles: async () => { actions.push("files"); },
    sendAttachedPrompt: async () => { actions.push("send"); return "user_turn"; },
    waitForNewAssistantTurn: async () => { throw reachedObservation; },
  });
  let released = 0;
  const prepared = (text: string) => async () => ({ text, images: [], release: () => { released += 1; } });
  try {
    const outcome = await worker.runBrowserTurn({
      traceId: "retained_guard_fixture",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities,
      ...(options.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
      prepare: prepared("FULL CONTEXT"),
      prepareResume: prepared("ONLY THE NEW MESSAGE"),
    }, "owned-surface", page, true).then(() => undefined, (error: unknown) => error);
    return { outcome, actions, released, reachedObservation };
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
}

test("a resumed turn sends its delta when the page still shows the retained conversation", async () => {
  const { outcome, actions, reachedObservation } = await runResumedTurn({ assistantTurns: 2 });
  expect(outcome).toBe(reachedObservation);
  expect(actions).toEqual(["effort:high", "attach", "files", "send"]);
});

test("a resumed turn on a page that lost its conversation sends nothing and asks for a full-context retry", async () => {
  const { outcome, actions, released } = await runResumedTurn({ assistantTurns: 0 });
  expect(outcome).toBeInstanceOf(ChatGptWebAdapterError);
  expect((outcome as ChatGptWebAdapterError).code).toBe("retained_conversation_lost");
  expect((outcome as ChatGptWebAdapterError).retryable).toBeTrue();
  expect(actions).toEqual([]);
  expect(released).toBe(1);
});

test("a reload during a resumed turn is caught before the delta is submitted", async () => {
  const { outcome, actions } = await runResumedTurn({ assistantTurns: 3, reloadDuringEffort: true });
  expect((outcome as ChatGptWebAdapterError).code).toBe("retained_conversation_lost");
  expect(actions).toEqual(["effort:high", "attach", "files"]);
  expect(actions).not.toContain("send");
});

test("follow-ups and compaction handoffs keep their fall-back code when the retained conversation is gone", async () => {
  const { outcome, actions } = await runResumedTurn({ assistantTurns: 0, requireRetainedConversation: true });
  expect((outcome as ChatGptWebAdapterError).code).toBe("compaction_source_unavailable");
  expect(actions).toEqual([]);
});

test("a personalization proof outlives the per-turn Page object on the same launcher surface", () => {
  // Every launcher turn opens a new CDP connection and so a new Page; the surface id is what stays.
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    launcherSurfaceByPage: WeakMap<object, string>;
    proofKey(page: object): object | string;
  };
  worker.launcherSurfaceByPage = new WeakMap();
  const cache = new ChatGptPersonalizationProofCache();
  const firstTurnPage = {};
  const nextTurnPage = {};
  const otherSurfacePage = {};
  worker.launcherSurfaceByPage.set(firstTurnPage, "surface-a");
  worker.launcherSurfaceByPage.set(nextTurnPage, "surface-a");
  worker.launcherSurfaceByPage.set(otherSurfacePage, "surface-b");
  cache.remember(worker.proofKey(firstTurnPage), "session-1", 0);
  expect(cache.isValid(worker.proofKey(nextTurnPage), "session-1", 30_000)).toBeTrue();
  expect(cache.isValid(worker.proofKey(otherSurfacePage), "session-1", 30_000)).toBeFalse();
  // A different signed-in session never inherits the proof, and the proof still expires.
  expect(cache.isValid(worker.proofKey(nextTurnPage), "session-2", 30_000)).toBeFalse();
  cache.remember(worker.proofKey(firstTurnPage), "session-1", 0);
  expect(cache.isValid(worker.proofKey(nextTurnPage), "session-1", 61 * 60_000)).toBeFalse();
  // Outside the launcher a Page is still its own key.
  const managedPage = {};
  cache.remember(worker.proofKey(managedPage), "session-1", 0);
  expect(cache.isValid(managedPage, "session-1", 1_000)).toBeTrue();
});

test("a refreshed ChatGPT session token keeps the personalization proof, and a miss names its reason", async () => {
  // v5.0.50 live test: ChatGPT re-issued its session token between turns, so a key hashed from
  // the token's value changed every turn and the proof was never reused.
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    personalizationSessionKey(page: unknown): Promise<string | undefined>;
  };
  const pageWith = (cookies: Array<{ name: string; value: string }>) => ({
    context: () => ({ cookies: async () => cookies }),
  });
  const before = await worker.personalizationSessionKey(pageWith([
    { name: "__Secure-next-auth.session-token", value: "first-issued-token" },
    { name: "oai-did", value: "device" },
  ]));
  const after = await worker.personalizationSessionKey(pageWith([
    { name: "__Secure-next-auth.session-token", value: "re-issued-token" },
  ]));
  expect(before).toBeDefined();
  expect(after).toBe(before);
  expect(await worker.personalizationSessionKey(pageWith([{ name: "oai-did", value: "device" }]))).toBeUndefined();

  const cache = new ChatGptPersonalizationProofCache();
  expect(cache.status("surface-a", before, 0)).toBe("none");
  cache.remember("surface-a", before, 0);
  expect(cache.status("surface-a", after, 1_000)).toBe("hit");
  expect(cache.status("surface-a", undefined, 2_000)).toBe("no_session");
  cache.remember("surface-a", before, 0);
  expect(cache.status("surface-a", "another-session", 2_000)).toBe("session_changed");
  cache.remember("surface-a", before, 0);
  expect(cache.status("surface-a", before, 61 * 60_000)).toBe("expired");
});

test("the signed-in check reads the page's own cookies when the CDP context lists none", async () => {
  // 28.09: over the launcher's CDP connection context.cookies() returned 0 cookies, so every proof
  // lookup was no_session, while the page's Network domain saw 169 cookies with the session.
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    personalizationSessionKey(page: unknown): Promise<string | undefined>;
  };
  let detached = 0;
  const pageWith = (pageCookies: Array<{ name: string; value: string }>) => ({
    context: () => ({
      cookies: async () => [],
      newCDPSession: async () => ({
        send: async (method: string) => {
          expect(method).toBe("Network.getCookies");
          return { cookies: pageCookies };
        },
        detach: async () => { detached += 1; },
      }),
    }),
  });
  expect(await worker.personalizationSessionKey(pageWith([
    { name: "__Secure-next-auth.session-token.0", value: "chunk" },
    { name: "__Secure-next-auth.session-token.1", value: "chunk" },
  ]))).toBe("chatgpt-signed-in");
  expect(await worker.personalizationSessionKey(pageWith([{ name: "oai-did", value: "device" }]))).toBeUndefined();
  expect(detached).toBe(2);
});
