import { expect, test } from "bun:test";
import { chatGptPageAnswers } from "../src/adapters/chatgpt-web/browser-worker";

// 30.09: a heavy conversation kept ChatGPT's renderer busy in back-to-back 2.3 s React renders.
// Probe timeouts were taken for a dead connection and the turn was failed after two 40 s rebinds.
// The liveness read is what separates a busy page from a detached one.

test("a page that answers a trivial read, however slowly, is busy rather than detached", async () => {
  const slow = { evaluate: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return 1; } };
  expect(await chatGptPageAnswers(slow as never, 1_000)).toBeTrue();
});

test("a page that never answers, or whose connection is gone, is not", async () => {
  const hung = { evaluate: () => new Promise(() => {}) };
  expect(await chatGptPageAnswers(hung as never, 50)).toBeFalse();
  const closed = { evaluate: async () => { throw new Error("Target page, context or browser has been closed"); } };
  expect(await chatGptPageAnswers(closed as never, 1_000)).toBeFalse();
});
