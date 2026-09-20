import { expect, test } from "bun:test";
import { WindowRecoveryTracker, isMinimizedGuidance, windowTargetOf } from "../src/adapters/chatgpt-web/window-recovery";
import type { BrokerToolRequest } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexContentPart, CodexToolResultMessage } from "../src/types";

/**
 * The shapes below are copied from the rollout records in ~/.codex/archived_sessions: a live
 * minimized result is two text parts and `isError: false`, and the recovered call returns an image.
 */
const MINIMIZED = "window is minimized; call activate_window, refresh with get_window, then retry get_window_state";
const POLICY_STOP = "Computer Use has been stopped for this turn because it could not determine the current"
  + " browser URL on Windows with enough confidence to enforce policy. Stop your work and send a"
  + " final message noting why Computer Use ended.";

function jsCall(callId: string, code: string): BrokerToolRequest {
  return { callId, wireName: "js", freeform: false, arguments: { code, title: "Pencerenin durumunu oku" } };
}

function result(toolCallId: string, content: string | CodexContentPart[]): CodexToolResultMessage {
  return { role: "toolResult", toolCallId, toolName: "js", content, isError: false, timestamp: 0 };
}

function output(text: string): CodexContentPart[] {
  return [{ type: "text", text: "Wall time: 0.0881 seconds\nOutput:" }, { type: "text", text }];
}

const GET_STATE = "globalThis.ws = await sky.get_window_state({ window: { id: 4589948, app: 'process:C:\\\\Feno.exe' } });";

test("the recorded minimized result recovers without being treated as an error", () => {
  const message = result("call_1", output(MINIMIZED));
  expect(message.isError).toBeFalse();

  const outcome = new WindowRecoveryTracker().inspect(jsCall("call_1", GET_STATE), message);
  expect(outcome?.kind).toBe("recover");
  if (outcome?.kind !== "recover") throw new Error("unreachable");
  expect(outcome.target).toBe("process:C:\\\\Feno.exe#4589948");
  expect(outcome.note).toContain("not a refusal");
  expect(outcome.note).toContain("include_screenshot: true");
});

test("an image from the recovered window is what counts as success", () => {
  const tracker = new WindowRecoveryTracker();
  const call = jsCall("call_1", GET_STATE);
  expect(tracker.inspect(call, result("call_1", output(MINIMIZED)))?.kind).toBe("recover");

  const image: CodexContentPart[] = [{ type: "image", imageUrl: "data:image/jpeg;base64,/9j/4AAQ" }];
  const outcome = tracker.inspect(jsCall("call_2", GET_STATE), result("call_2", image));
  expect(outcome?.kind).toBe("succeeded");
});

test("an image of a different window does not close the recovery", () => {
  const tracker = new WindowRecoveryTracker();
  tracker.inspect(jsCall("call_1", GET_STATE), result("call_1", output(MINIMIZED)));

  const otherWindow = "await sky.get_window_state({ window: { id: 657538, app: 'process:C:\\\\Other.exe' } });";
  const image: CodexContentPart[] = [{ type: "image", imageUrl: "data:image/jpeg;base64,/9j/4AAQ" }];
  expect(tracker.inspect(jsCall("call_2", otherWindow), result("call_2", image))?.kind).not.toBe("succeeded");
});

test("an image that did not come from observing the window does not close the recovery", () => {
  const tracker = new WindowRecoveryTracker();
  tracker.inspect(jsCall("call_1", GET_STATE), result("call_1", output(MINIMIZED)));

  // Same window id, but the call read a file rather than observing the window.
  const unrelated = jsCall("call_2", "nodeRepl.emitImage({ bytes: readFileSync('shot-4589948.jpg') });");
  const image: CodexContentPart[] = [{ type: "image", imageUrl: "data:image/jpeg;base64,/9j/4AAQ" }];
  expect(tracker.inspect(unrelated, result("call_2", image))?.kind).not.toBe("succeeded");
});

test("a policy stop outranks recovery and nothing is sent back", () => {
  const tracker = new WindowRecoveryTracker();
  expect(tracker.inspect(jsCall("call_1", GET_STATE), result("call_1", output(POLICY_STOP)))?.kind).toBe("stand_down");

  // A stop arriving after a recovery is pending also clears it.
  const later = new WindowRecoveryTracker();
  later.inspect(jsCall("call_1", GET_STATE), result("call_1", output(MINIMIZED)));
  expect(later.inspect(jsCall("call_2", GET_STATE), result("call_2", output(POLICY_STOP)))?.kind).toBe("stand_down");
  const image: CodexContentPart[] = [{ type: "image", imageUrl: "data:image/jpeg;base64,/9j/4AAQ" }];
  expect(later.inspect(jsCall("call_3", GET_STATE), result("call_3", image))?.kind).not.toBe("succeeded");
});

test("a policy stop prevents later recovery in the same turn", () => {
  const tracker = new WindowRecoveryTracker();
  expect(tracker.inspect(jsCall("call_1", GET_STATE), result("call_1", output(POLICY_STOP)))?.kind).toBe("stand_down");
  expect(tracker.inspect(jsCall("call_2", GET_STATE), result("call_2", output(MINIMIZED)))?.kind).not.toBe("recover");
});

test("policy-stop text quoted by an unrelated call does not disable recovery", () => {
  const tracker = new WindowRecoveryTracker();
  const read: BrokerToolRequest = {
    callId: "call_1",
    wireName: "exec_command",
    freeform: false,
    arguments: { cmd: "rg get_window_state AGENTS.md" },
  };
  expect(tracker.inspect(read, result("call_1", output(POLICY_STOP)))?.kind)
    .not.toBe("stand_down");
  expect(tracker.inspect(jsCall("call_2", GET_STATE), result("call_2", output(MINIMIZED)))?.kind).toBe("recover");
});

test("exact minimized guidance from a non-JavaScript call does not trigger recovery", () => {
  const read: BrokerToolRequest = {
    callId: "call_1",
    wireName: "exec_command",
    freeform: false,
    arguments: { cmd: "rg get_window_state AGENTS.md" },
  };
  expect(new WindowRecoveryTracker().inspect(read, result("call_1", output(MINIMIZED)))?.kind).not.toBe("recover");
});

test("the sentence quoted inside a document does not trigger recovery", () => {
  // Both of these really occurred: a transcript the model was reading back, and this machine's own
  // AGENTS.md, which states the rule verbatim.
  const transcript = `173:> MCP tool call\n181:> }\n184:> Error: ${MINIMIZED}\n186:> </details>\n` + "x".repeat(12_000);
  const agentsMd = `## Screenshots\n\n\`${MINIMIZED}\` is that API telling you what to do next, not a refusal.\n`
    + "y".repeat(11_000);
  for (const text of [transcript, agentsMd]) {
    expect(isMinimizedGuidance(text)).toBeFalse();
    const read: BrokerToolRequest = {
      callId: "call_1",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "rg -n get_window_state AGENTS.md" },
    };
    expect(new WindowRecoveryTracker().inspect(read, result("call_1", output(text)))?.kind).not.toBe("recover");
  }
});

test("a call that never asked to observe a window is left alone", () => {
  const unrelated: BrokerToolRequest = {
    callId: "call_1",
    wireName: "js",
    freeform: false,
    arguments: { code: "nodeRepl.write(String(await sky.list_windows()));" },
  };
  expect(new WindowRecoveryTracker().inspect(unrelated, result("call_1", output(MINIMIZED)))?.kind).toBeUndefined();
});

test("recovery is sent back at most once per turn", () => {
  const tracker = new WindowRecoveryTracker();
  expect(tracker.inspect(jsCall("call_1", GET_STATE), result("call_1", output(MINIMIZED)))?.kind).toBe("recover");
  expect(tracker.inspect(jsCall("call_2", GET_STATE), result("call_2", output(MINIMIZED)))?.kind).not.toBe("recover");
  expect(tracker.inspect(jsCall("call_3", GET_STATE), result("call_3", output(MINIMIZED)))?.kind).not.toBe("recover");
});

test("a window selected through a variable recovers with an unbound target", () => {
  const byVariable = "globalThis.ws2 = await sky.get_window_state({window: windows[0]});";
  expect(windowTargetOf(jsCall("call_1", byVariable))).toBeUndefined();
  const outcome = new WindowRecoveryTracker().inspect(jsCall("call_1", byVariable), result("call_1", output(MINIMIZED)));
  expect(outcome?.kind).toBe("recover");
  if (outcome?.kind !== "recover") throw new Error("unreachable");
  expect(outcome.target).toBeUndefined();
  expect(outcome.note).not.toContain("undefined");
});

test("a reworded runtime message is reported rather than passing silently", () => {
  // The sentence comes from the @oai/sky runtime, which cannot be version-checked against the
  // installed plugin files. A future wording must surface in the log, not vanish.
  const reworded = "window is currently minimized - restore it before capturing state";
  const outcome = new WindowRecoveryTracker().inspect(jsCall("call_1", GET_STATE), result("call_1", output(reworded)));
  expect(outcome?.kind).toBe("near_miss");
  if (outcome?.kind !== "near_miss") throw new Error("unreachable");
  expect(outcome.text).toBe(reworded);
});
