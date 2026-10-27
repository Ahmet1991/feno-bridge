import { expect, test } from "bun:test";
import { ChatGptCompletionTracker, ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";

// Adapted from upstream ffe041f (#885): a final can arrive 125 seconds after Stop disappears.
test("a delayed final survives quiet UI after Stop disappears and still requires completion evidence", () => {
  const health = new ChatGptTurnDomHealthTracker();
  const completion = new ChatGptCompletionTracker();
  const quiet = { responsePresent: true, running: false, currentText: "Preparing the result.", completionActionVisible: false };
  for (const now of [0, 60_000, 124_999]) {
    expect(health.update(quiet, now)).toBeUndefined();
    expect(completion.update(quiet, now)).toBeFalse();
  }
  const final = { ...quiet, currentText: "The requested work is complete.", completionActionVisible: true };
  expect(health.update(final, 125_000)).toBeUndefined();
  expect(completion.update(final, 125_000)).toBeFalse();
  expect(completion.update(final, 127_000)).toBeTrue();
});

test("quiet UI remains bounded while empty completion and missing DOM keep their shorter failure windows", () => {
  const quiet = { responsePresent: true, running: false, currentText: "Preparing the result.", completionActionVisible: false };
  const health = new ChatGptTurnDomHealthTracker();
  expect(health.update(quiet, 0)).toBeUndefined();
  expect(health.update(quiet, 599_999)).toBeUndefined();
  expect(health.update(quiet, 600_000)).toContain("completed-turn action");
  const empty = new ChatGptTurnDomHealthTracker();
  const completedEmpty = { ...quiet, currentText: "", completionActionVisible: true };
  expect(empty.update(completedEmpty, 0)).toBeUndefined();
  expect(empty.update(completedEmpty, 10_000)).toContain("completed without a final answer");
  const missing = new ChatGptTurnDomHealthTracker();
  expect(missing.update({ ...quiet, responsePresent: false }, 0)).toBeUndefined();
  expect(missing.update({ ...quiet, responsePresent: false }, 60_000)).toContain("did not create a response DOM");
});
