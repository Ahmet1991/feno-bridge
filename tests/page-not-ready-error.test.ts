import { expect, test } from "bun:test";
import { adapterFailureFromMessage, classifyError } from "../src/lib/errors";

test("a page that was not ready is not reported as an overloaded model (01.10)", () => {
  // 01.10: "ChatGPT composer is unavailable" reached Codex as server_is_overloaded, which Codex
  // shows as "Selected model is at capacity"; the model had never been reached.
  for (const message of [
    "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.",
    "ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.",
  ]) {
    const failure = adapterFailureFromMessage(message);
    expect(failure.error.code).toBe("chatgpt_page_not_ready");
    expect(failure.error.type).toBe("server_error");
    expect(failure.error.message).toBe(message);
  }
});

test("a real overload keeps the code Codex backs off on", () => {
  expect(classifyError(503, "server_error", "The server is overloaded").code).toBe("server_is_overloaded");
  expect(adapterFailureFromMessage("Service temporarily unavailable").error.code).toBe("server_is_overloaded");
});
