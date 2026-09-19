import { expect, test } from "bun:test";
import { formatBrowserTurnReactionLog } from "../src/adapters/chatgpt-web/reaction-timing";

test("accepted inline and multipart turns each emit one compact reaction line with stage timings", () => {
  const stages = new Map([["browser_page", 412.7], ["effort_selection", 0.2], ["send", 1987.5]]);
  expect(formatBrowserTurnReactionLog({
    traceId: "turn_123", elapsedMs: 3030.7, reused: true, stages,
  })).toBe("[chatgpt-web] browser turn turn_123 reaction ms=3031 conversation=reused transport=inline stages=browser_page:413,effort_selection:0,send:1988");
  expect(formatBrowserTurnReactionLog({
    traceId: "turn_456", elapsedMs: 42600, reused: false, multipartParts: 3, stages,
  })).toBe("[chatgpt-web] browser turn turn_456 reaction ms=42600 conversation=new transport=multipart-3 stages=browser_page:413,effort_selection:0,send:1988");
});
