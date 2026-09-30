import { afterEach, expect, spyOn, test } from "bun:test";
import {
  ChatGptCompletionTracker,
  watchChatGptToolBoundary,
  withBrowserTurnAbort,
} from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

// 30.09: ChatGPT asked for a command while its page carried 785k characters of text. Every DOM
// probe outlasted its budget, the command waited for a boundary read that never came, its MCP call
// expired after 90 seconds, and the Codex task failed as "ChatGPT stopped responding". Codex's
// five reconnects then replayed that failure. The helper also crashed afterwards on a page probe
// it had started for an already aborted turn.

const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const completedState = (currentText: string) => ({
  responsePresent: true,
  running: false,
  currentText,
  completionActionVisible: true,
});

test("an unread page releases the tool batch on the last answer text it read", async () => {
  const progress = new ChatGptExternalTurnProgress();
  const tracker = new ChatGptCompletionTracker(0, 0);
  tracker.update({ ...completedState("Önce teklif dosyasına bakıyorum."), running: true });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    stops.push(watchChatGptToolBoundary(progress, tracker, "abc123def456", 20));
    const revision = progress.recordToolBatch(1);
    await Promise.race([
      progress.waitForToolBatchObservation(revision),
      sleep(2_000).then(() => { throw new Error("the batch was never released"); }),
    ]);
    expect(tracker.needsToolBatchObservation(revision)).toBeFalse();
    expect(warn.mock.calls.map(call => String(call[0])).join("\n"))
      .toContain("released tool batch 1 on its last read answer after 20ms");
  } finally {
    warn.mockRestore();
  }
  // The released boundary is that last read: a turn that ends on exactly it still produced no
  // answer after the command, and new text is the answer.
  progress.recordToolResult();
  expect(() => tracker.update(completedState("Önce teklif dosyasına bakıyorum."))).toThrow(
    "ChatGPT completed without producing a final answer after its last Codex tool call",
  );
  expect(tracker.update(completedState("Önce teklif dosyasına bakıyorum.\n\nTeklif hazır."))).toBeFalse();
});

test("a batch the observation loop acknowledges in time is not released again", async () => {
  const progress = new ChatGptExternalTurnProgress();
  const tracker = new ChatGptCompletionTracker();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    stops.push(watchChatGptToolBoundary(progress, tracker, "abc123def456", 20));
    const revision = progress.recordToolBatch(1);
    tracker.observeToolBatch(revision, "okunan metin");
    await progress.acknowledgeToolBatch(revision);
    await sleep(60);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("a finished turn stops its pending release", async () => {
  const progress = new ChatGptExternalTurnProgress();
  const tracker = new ChatGptCompletionTracker();
  const stop = watchChatGptToolBoundary(progress, tracker, "abc123def456", 20);
  const revision = progress.recordToolBatch(1);
  stop();
  await sleep(60);
  expect(tracker.needsToolBatchObservation(revision)).toBeTrue();
});

test("a page probe started for an aborted turn cannot crash the helper when it fails later", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    let failLater!: (error: Error) => void;
    const probe = new Promise<number>((_resolve, reject) => { failLater = reject; });
    await expect(withBrowserTurnAbort(probe, AbortSignal.abort())).rejects.toThrow("ChatGPT web turn aborted");
    failLater(new Error("locator.count: Target page, context or browser has been closed"));
    await sleep(20);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
