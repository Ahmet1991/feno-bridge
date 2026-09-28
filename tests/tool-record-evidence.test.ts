import { expect, test } from "bun:test";
import {
  parseChatGptToolRecordEvidence,
  summarizeChatGptToolRecord,
} from "../src/adapters/chatgpt-web/tool-record-evidence";
import { falseBlockCorrection } from "../src/adapters/chatgpt-web/false-block-recovery";
import { formatBlockClaimEvidence } from "../src/adapters/chatgpt-web/block-claim-evidence";

const REFUSAL = "Bu araç çağrısı, isteğin güvenlik durumunu belirleyemediğimiz için OpenAI tarafından engellendi.";

type Node = { parent: string | null; children: string[]; role: string | null; recipient: string | null; text: string };

/** A chain of messages, each the only child of the one before, as ChatGPT's mapping stores them. */
function chain(messages: Array<Omit<Node, "parent" | "children"> & { id: string; extra?: string[] }>): Record<string, Node> {
  const nodes: Record<string, Node> = {};
  messages.forEach((message, index) => {
    nodes[message.id] = {
      parent: index === 0 ? null : messages[index - 1]!.id,
      children: [...(index + 1 < messages.length ? [messages[index + 1]!.id] : []), ...(message.extra ?? [])],
      role: message.role,
      recipient: message.recipient,
      text: message.text,
    };
  });
  return nodes;
}

test("28.09: a click with nothing under it and a refusal only in the answer reads as unanswered, not refused", () => {
  // The record of the capability test, reduced to its shape: two answered view_image calls, the
  // click call whose only child is the model's next thought, then the answer quoting a refusal.
  const nodes = chain([
    { id: "u", role: "user", recipient: "all", text: "10 test" },
    { id: "c1", role: "assistant", recipient: "api_tool.call_tool", text: "codex_view_image" },
    { id: "r1", role: "tool", recipient: "all", text: "[Feno Bridge] This tool returned an image" },
    { id: "c2", role: "assistant", recipient: "api_tool.call_tool", text: "codex_view_image" },
    { id: "r2", role: "tool", recipient: "all", text: "[Feno Bridge] This tool returned an image" },
    { id: "t1", role: "assistant", recipient: "all", text: "Ekran görüntüsünü inceleyip test sonuçlarını doğruladı" },
    { id: "click", role: "assistant", recipient: "api_tool.call_tool", text: "codex_tool_call sky.click" },
    { id: "t2", role: "assistant", recipient: "all", text: "Hesap Makinesi’nde çarpma işlemini gerçekleştirdi" },
    { id: "answer", role: "assistant", recipient: "all", text: `TEST 10 ❌ … engellendi: “${REFUSAL}”` },
  ]);
  expect(summarizeChatGptToolRecord({ currentNode: "answer", nodes })).toEqual({
    unansweredCalls: 1,
    platformRefusal: false,
  });
});

test("a refusal ChatGPT really returned under the call is recognised as the platform's", () => {
  const nodes = chain([
    { id: "u", role: "user", recipient: "all", text: "run it" },
    { id: "call", role: "assistant", recipient: "api_tool.call_tool", text: "codex_tool_call" },
    { id: "refusal", role: "tool", recipient: "all", text: JSON.stringify({ parts: [REFUSAL] }) },
    { id: "answer", role: "assistant", recipient: "all", text: REFUSAL },
  ]);
  expect(summarizeChatGptToolRecord({ currentNode: "answer", nodes })).toEqual({
    unansweredCalls: 0,
    platformRefusal: true,
  });
});

test("a tool's own 'denied' output is a result, not a platform refusal", () => {
  const nodes = chain([
    { id: "u", role: "user", recipient: "all", text: "read it" },
    { id: "call", role: "assistant", recipient: "api_tool.call_tool", text: "codex_tool_call" },
    { id: "result", role: "tool", recipient: "all", text: "Get-Content : Access to the path is denied. blocked" },
    { id: "answer", role: "assistant", recipient: "all", text: "engellendi" },
  ]);
  expect(summarizeChatGptToolRecord({ currentNode: "answer", nodes })).toEqual({
    unansweredCalls: 0,
    platformRefusal: false,
  });
});

test("only this turn counts: an older turn's unanswered call stays behind its user message", () => {
  const nodes = chain([
    { id: "u1", role: "user", recipient: "all", text: "first" },
    { id: "old", role: "assistant", recipient: "api_tool.call_tool", text: "codex_tool_call" },
    { id: "a1", role: "assistant", recipient: "all", text: "first answer" },
    { id: "u2", role: "user", recipient: "all", text: "second" },
    { id: "a2", role: "assistant", recipient: "all", text: "second answer" },
  ]);
  expect(summarizeChatGptToolRecord({ currentNode: "a2", nodes })).toEqual({
    unansweredCalls: 0,
    platformRefusal: false,
  });
});

test("an unreadable record yields no evidence, so the older checks stay in charge", () => {
  expect(summarizeChatGptToolRecord(null)).toBeUndefined();
  expect(summarizeChatGptToolRecord({ currentNode: 1, nodes: {} })).toBeUndefined();
  expect(summarizeChatGptToolRecord({ currentNode: "missing", nodes: {} })).toBeUndefined();
  expect(parseChatGptToolRecordEvidence({ unansweredCalls: -1, platformRefusal: false })).toBeUndefined();
  expect(parseChatGptToolRecordEvidence({ unansweredCalls: 2, platformRefusal: "no" })).toBeUndefined();
  expect(parseChatGptToolRecordEvidence({ unansweredCalls: 2, platformRefusal: false }))
    .toEqual({ unansweredCalls: 2, platformRefusal: false });
});

test("with the record read, the correction closes the 'ChatGPT showed it' door and names the silent call", () => {
  const text = falseBlockCorrection({ completed: 44, failed: 0 }, { unansweredCalls: 1, platformRefusal: false });
  expect(text).toContain("Köprü ChatGPT'nin bu sohbet için tuttuğu kaydı da okudu");
  expect(text).toContain("1 araç çağrının altında ne bir sonuç ne de bir hata var");
  expect(text).toContain("geri çek");
  expect(text).toContain("Bu cevapta araç çağırma.");
  expect(text).not.toContain("aynen koru");
  // Without a record the bridge still cannot rule out a refusal it never saw.
  expect(falseBlockCorrection({ completed: 44, failed: 0 })).toContain("aynen koru");
});

test("the footer tells the user what ChatGPT's own record shows", () => {
  const silent = formatBlockClaimEvidence({ completed: 44, failed: 0 }, { unansweredCalls: 1, platformRefusal: false });
  expect(silent).toContain("köprüye ulaşan 44 araç çağrısı");
  expect(silent).toContain("1 araç çağrısının altında ne bir sonuç ne de bir hata ya da red mesajı var");
  const refused = formatBlockClaimEvidence({ completed: 3, failed: 0 }, { unansweredCalls: 0, platformRefusal: true });
  expect(refused).toContain("bir platform red mesajı var");
  expect(formatBlockClaimEvidence({ completed: 3, failed: 0 })).not.toContain("sohbet kaydında");
});
