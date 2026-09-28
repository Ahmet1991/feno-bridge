import { expect, test } from "bun:test";
import { ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  assertChatGptTurnProgressSnapshot,
  ChatGptExternalTurnProgress,
  ChatGptMirroredTurnProgress,
  type ChatGptExternalTurnProgressSnapshot,
} from "../src/adapters/chatgpt-web/turn-progress";

// 28.09 00:28-00:29 UTC: Codex compacted a 225-item session mid-turn, the broker intercepted
// ChatGPT's next call and told it to end its response, and ChatGPT did exactly that, with no new
// text. The browser read that as "completed without producing a final answer after its last Codex
// tool call", the source turn failed with its retained conversation, and the task could not go on.
const ended = {
  responsePresent: true,
  running: false,
  currentText: "Checked the mailbox filters.",
  currentHtml: "<p>Checked the mailbox filters.</p>",
  completionActionVisible: true,
};

test("an end with no new text after a tool call is still a missing answer", () => {
  const tracker = new ChatGptCompletionTracker(10, 100);
  tracker.observeToolBatch(1, ended.currentText);
  expect(tracker.update(ended, 0)).toBeFalse();
  expect(() => tracker.update(ended, 100)).toThrow("without producing a final answer after its last Codex tool call");
});

test("the same end after a compaction interception is the requested stop and settles", () => {
  const tracker = new ChatGptCompletionTracker(10, 100);
  tracker.observeToolBatch(1, ended.currentText);
  const stopped = { ...ended, stoppedForCompaction: true };
  expect(tracker.update(stopped, 0)).toBeFalse();
  expect(tracker.update(stopped, 10)).toBeTrue();
  // It never waits out the missing-answer grace either.
  expect(tracker.update(stopped, 10_000)).toBeTrue();
});

test("a compaction stop reaches the browser helper and cannot be taken back", () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordToolBatch(1, 1_000);
  progress.recordToolResult(2_000);
  const before = progress.snapshot();
  expect(before.stoppedForCompaction).toBeUndefined();

  progress.recordCompactionStop(3_000);
  const stopped = progress.snapshot();
  expect(stopped).toMatchObject({ stoppedForCompaction: true, revision: before.revision + 1 });
  // Not model progress: the last proven MCP activity keeps its time.
  expect(stopped.lastProgressAt).toBe(2_000);
  progress.recordCompactionStop(4_000);
  expect(progress.snapshot().revision).toBe(stopped.revision);

  const mirror = new ChatGptMirroredTurnProgress();
  expect(mirror.apply(stopped)).toBeTrue();
  expect(mirror.snapshot().stoppedForCompaction).toBeTrue();
  const { stoppedForCompaction: _dropped, ...withoutStop } = stopped;
  expect(() => mirror.apply({ ...withoutStop, revision: stopped.revision + 1 })).toThrow("regressed");

  expect(() => assertChatGptTurnProgressSnapshot({
    ...stopped,
    stoppedForCompaction: false,
  } as unknown as ChatGptExternalTurnProgressSnapshot)).toThrow("invalid");
});

test("a retired turn records no compaction stop", () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordToolBatch(1, 1_000);
  progress.retire(new Error("capability retired"));
  const retired = progress.snapshot();
  progress.recordCompactionStop(2_000);
  expect(progress.snapshot()).toEqual(retired);
});
