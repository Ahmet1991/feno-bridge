import { expect, test } from "bun:test";
import {
  CHATGPT_RESPONSE_READ_TIMEOUT_MS,
  ChatGptBrowserWorker,
  MAX_CHATGPT_RESPONSE_READ_TIMEOUT_MS,
  nextChatGptResponseReadTimeoutMs,
} from "../src/adapters/chatgpt-web/browser-worker";

test("the response read budget doubles after a timeout and relaxes once reads are quick again", () => {
  expect(nextChatGptResponseReadTimeoutMs(2_000, { timedOut: true, elapsedMs: 2_000 })).toBe(4_000);
  expect(nextChatGptResponseReadTimeoutMs(8_000, { timedOut: true, elapsedMs: 8_000 })).toBe(MAX_CHATGPT_RESPONSE_READ_TIMEOUT_MS);
  expect(nextChatGptResponseReadTimeoutMs(16_000, { timedOut: true, elapsedMs: 16_000 })).toBe(16_000);
  // A 4.5 s read under an 8 s budget is where the busy page answers: the budget holds there.
  expect(nextChatGptResponseReadTimeoutMs(8_000, { timedOut: false, elapsedMs: 4_500 })).toBe(8_000);
  expect(nextChatGptResponseReadTimeoutMs(8_000, { timedOut: false, elapsedMs: 300 })).toBe(4_000);
  expect(nextChatGptResponseReadTimeoutMs(2_000, { timedOut: false, elapsedMs: 10 })).toBe(CHATGPT_RESPONSE_READ_TIMEOUT_MS);
});

test("a busy page's response is read once the budget grows past its read time (01.10)", async () => {
  // The page answers a read in 4.5 s, as the 9-part IPTV conversation did on 01.10.
  const budgets: number[] = [];
  let clock = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => clock;
  const locator = {
    evaluate: async (_callback: unknown, _options: unknown, evaluateOptions: { timeout: number }) => {
      budgets.push(evaluateOptions.timeout);
      if (evaluateOptions.timeout < 4_500) {
        clock += evaluateOptions.timeout;
        throw Object.assign(new Error(`locator.evaluate: Timeout ${evaluateOptions.timeout}ms exceeded.`), { name: "TimeoutError" });
      }
      clock += 4_500;
      return {
        key: `read-${budgets.length}`,
        snapshot: {
          responsePresent: true,
          visibleText: "",
          fullHtml: "",
          markdownSegments: [],
          completionActionVisible: false,
          stoppedThinkingVisible: false,
          traceBlocks: [{ kind: "commentary", text: "Task 4 entegrasyon noktaları netleşti.", complete: true }],
        },
      };
    },
    page: () => ({ isClosed: () => false }),
  };
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    responseDomSnapshot(locator: unknown, cache: object): Promise<{ responsePresent: boolean; traceBlocks: unknown[] }>;
  };
  const cache: { readTimeoutMs?: number } = {};
  const warn = console.warn;
  console.warn = () => {};
  try {
    const reads = [];
    for (let read = 0; read < 4; read += 1) reads.push(await worker.responseDomSnapshot(locator, cache));
    // A fixed 2 s budget never read this page; the third read, with 8 s, does and keeps it.
    expect(budgets).toEqual([2_000, 4_000, 8_000, 8_000]);
    expect(reads.map(read => read.responsePresent)).toEqual([false, false, true, true]);
    expect(reads[2]!.traceBlocks).toHaveLength(1);
    expect(cache.readTimeoutMs).toBe(8_000);
  } finally {
    console.warn = warn;
    performance.now = realNow;
  }
});

test("a read that fails for another reason does not grow the budget", async () => {
  const locator = {
    evaluate: async () => { throw new Error("Execution context was destroyed"); },
    page: () => ({ isClosed: () => false }),
  };
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    responseDomSnapshot(locator: unknown, cache: object): Promise<{ responsePresent: boolean }>;
  };
  const cache: { readTimeoutMs?: number } = {};
  expect((await worker.responseDomSnapshot(locator, cache)).responsePresent).toBeFalse();
  expect(cache.readTimeoutMs).toBe(CHATGPT_RESPONSE_READ_TIMEOUT_MS);
});
