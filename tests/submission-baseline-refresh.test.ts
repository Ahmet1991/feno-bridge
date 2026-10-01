import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, chatGptSubmissionEvidence } from "../src/adapters/chatgpt-web/browser-worker";

// 01.10 19:19 UTC, IPTV task: the baseline held three user turns. A turn from the request Codex
// had just cancelled appeared 1.3 s later, before Send. After Send the page held five.
const beforeAttachment = ["u1", "a1", "u2", "a2", "u3", "a3"];
const beforeSend = [...beforeAttachment, "u4-cancelled-request"];
const afterSend = { users: ["u1", "u2", "u3", "u4-cancelled-request", "u5-new-message"] };

function pageWith(turnIdentities: string[]) {
  return {
    locator: () => ({}),
    evaluate: async () => ({
      key: `page:${turnIdentities.length}`,
      snapshot: {
        userTurnCount: turnIdentities.filter(identity => identity.startsWith("u")).length,
        assistantTurnCount: turnIdentities.filter(identity => identity.startsWith("a")).length,
        visibleStopButtonCount: 0,
        turnIdentities,
        userIdentities: turnIdentities.filter(identity => identity.startsWith("u")),
        responseIdentities: turnIdentities.filter(identity => identity.startsWith("a")),
      },
    }),
  };
}

test("a turn that appears while the prompt is attached does not count as this submission (01.10)", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    captureSubmissionBaseline(page: unknown): Promise<{ initialTurnIdentities: string[] }>;
    refreshSubmissionBaseline(
      page: unknown,
      baseline: { initialTurnIdentities: string[] },
      traceId: string,
    ): Promise<{ initialTurnIdentities: string[] }>;
  };
  const baseline = await worker.captureSubmissionBaseline(pageWith(beforeAttachment));

  // The baseline from before attachment reproduces the failure.
  expect(() => chatGptSubmissionEvidence({
    initialTurnIdentities: baseline.initialTurnIdentities,
    userIdentities: afterSend.users,
    responseIdentities: [],
    generationRunning: true,
  })).toThrow("ChatGPT exposed 2 new conversation turns for one submitted message");

  const info = console.info;
  const logged: string[] = [];
  console.info = (message: string) => { logged.push(message); };
  try {
    const refreshed = await worker.refreshSubmissionBaseline(pageWith(beforeSend), baseline, "trace01");
    expect(chatGptSubmissionEvidence({
      initialTurnIdentities: refreshed.initialTurnIdentities,
      userIdentities: afterSend.users,
      responseIdentities: [],
      generationRunning: true,
    })).toBe("user_turn");
    expect(logged).toEqual([
      "[chatgpt-web] browser turn trace01: 1 conversation turn(s) appeared while the prompt was being attached; they predate this submission",
    ]);
  } finally {
    console.info = info;
  }
});
