import { expect, test } from "bun:test";
import { describeCauseChain } from "../src/adapters/chatgpt-web/index";

test("an error with no cause describes itself", () => {
  expect(describeCauseChain(new TypeError("page closed"))).toBe("TypeError: page closed");
});

test("a chain names every link, nearest cause first", () => {
  const root = new Error("net::ERR_ABORTED");
  const middle = new Error("locator.click timed out", { cause: root });
  const outer = new Error("turn stage failed", { cause: middle });
  expect(describeCauseChain(outer)).toBe(
    "Error: turn stage failed <- Error: locator.click timed out <- Error: net::ERR_ABORTED",
  );
});

// This runs while a turn is already failing. A diagnostic that hangs would turn one bad turn into
// a stuck process, so the walk is bounded rather than trusting the chain to be well formed.
test("a cycle terminates instead of hanging", () => {
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  (first as { cause?: unknown }).cause = second;
  const described = describeCauseChain(first);
  expect(described.split(" <- ")).toHaveLength(8);
  expect(described.startsWith("Error: first <- Error: second")).toBe(true);
});

test("a chain deeper than the bound is truncated, not followed forever", () => {
  let error = new Error("depth-0");
  for (let depth = 1; depth < 40; depth += 1) error = new Error(`depth-${depth}`, { cause: error });
  const described = describeCauseChain(error);
  expect(described.split(" <- ")).toHaveLength(8);
  expect(described.split(" <- ").at(-1)).toBe("Error: depth-32");
});

test("a non-Error cause ends the chain rather than being printed as an object", () => {
  const outer = new Error("stage failed", { cause: { code: "ENOENT" } });
  expect(describeCauseChain(outer)).toBe("Error: stage failed");
});

test("a subclass reports its own name, so the failing stage is identifiable", () => {
  class ChatGptStageError extends Error {
    override name = "ChatGptStageError";
  }
  expect(describeCauseChain(new ChatGptStageError("composer never settled")))
    .toBe("ChatGptStageError: composer never settled");
});
