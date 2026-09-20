import { expect, spyOn, test } from "bun:test";
import { compileChatGptWebPromptWithinPageCapacity } from "../src/adapters/chatgpt-web/capacity";
import {
  compiledChatGptWebMaxMessageChars,
  compiledChatGptWebMessages,
} from "../src/adapters/chatgpt-web/input-tokens";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { estimateTokens } from "../src/lib/token-estimate";
import {
  chatGptWebImageTokenReserve,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../src/chatgpt-web-models";
import {
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import * as promptModule from "../src/adapters/chatgpt-web/prompt";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

function request(messages: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    options: { reasoning: "high" },
    context: { systemPrompt: ["preserve-system"], messages },
  };
}

type MultipartChunk = {
  index: number;
  total: number;
  content_item?: {
    index: number;
    chunk: { index: number; total: number };
  };
};

type MultipartRecord = {
  kind: "system" | "message";
  system_index?: number;
  message_index?: number;
  chunk?: MultipartChunk;
  content?: string;
  message?: Record<string, unknown>;
};

function multipartRecords(parts: readonly string[]): MultipartRecord[] {
  return parts.flatMap(part => {
    const payload = JSON.parse(part) as { records: MultipartRecord[] };
    return payload.records;
  });
}

function reconstructChunkedMessage(records: readonly MultipartRecord[], messageIndex: number): Record<string, unknown> {
  const chunks = records
    .filter(record => record.kind === "message" && record.message_index === messageIndex)
    .sort((left, right) => (left.chunk?.index ?? 0) - (right.chunk?.index ?? 0));
  expect(chunks.length).toBeGreaterThan(0);
  const first = structuredClone(chunks[0]!.message!);
  const firstContent = first.content;
  if (typeof firstContent === "string") {
    first.content = chunks.map(record => (record.message as { content: string }).content).join("");
    return first;
  }

  const rebuilt: unknown[] = [];
  let activeItem:
    | { itemIndex: number; nextChunk: number; totalChunks: number; value: Record<string, unknown> }
    | undefined;
  for (const record of chunks) {
    const content = (record.message as { content: unknown[] }).content;
    const itemChunk = record.chunk?.content_item;
    if (!itemChunk) {
      expect(activeItem).toBeUndefined();
      rebuilt.push(...content);
      continue;
    }
    expect(content).toHaveLength(1);
    const fragment = content[0] as Record<string, unknown>;
    expect(typeof fragment.text).toBe("string");
    if (itemChunk.chunk.index === 1) {
      expect(activeItem).toBeUndefined();
      activeItem = {
        itemIndex: itemChunk.index,
        nextChunk: 2,
        totalChunks: itemChunk.chunk.total,
        value: structuredClone(fragment),
      };
    } else {
      expect(activeItem?.itemIndex).toBe(itemChunk.index);
      expect(activeItem?.nextChunk).toBe(itemChunk.chunk.index);
      activeItem!.value.text = `${activeItem!.value.text as string}${fragment.text as string}`;
      activeItem!.nextChunk += 1;
    }
    if (itemChunk.chunk.index === itemChunk.chunk.total) {
      rebuilt.push(activeItem!.value);
      activeItem = undefined;
    }
  }
  expect(activeItem).toBeUndefined();
  first.content = rebuilt;
  return first;
}

test("page capacity chooses the smallest dynamic whole-record multipart transport", () => {
  const parsed = request(Array.from({ length: 4 }, (_unused, index) => ({
    role: "user" as const,
    content: `record-${index}-${"x".repeat(8_000)}`,
    timestamp: index + 1,
  })));
  const three = compileChatGptWebPrompt(parsed, capabilities, undefined, { multipartParts: 3 });
  const four = compileChatGptWebPrompt(parsed, capabilities, undefined, { multipartParts: 4 });
  const limit = compiledChatGptWebMaxMessageChars(four);
  expect(compiledChatGptWebMaxMessageChars(three)).toBeGreaterThan(limit);

  const compiled = compileChatGptWebPromptWithinPageCapacity(parsed, capabilities, undefined, {
    maxMessageChars: limit,
  });
  expect(compiled.multipart?.parts).toHaveLength(4);
  expect(Math.max(...compiledChatGptWebMessages(compiled).map(message => message.length))).toBeLessThanOrEqual(limit);

  const transactionId = `ctx_${"4".repeat(32)}`;
  const stage = formatChatGptWebMultipartStage(compiled.multipart!.parts[0]!, transactionId, 1, 4);
  expect(stage.acknowledgement).toContain(" 1/4 ");
  const commit = formatChatGptWebMultipartCommit(compiled.multipart!, transactionId);
  expect(commit).toContain("acknowledged_parts: 3/4");
  expect(commit).toMatch(/manifest: .*1\/4:[a-f0-9]{64} .*4\/4:[a-f0-9]{64}/);
});

test("multipart compiler balances whole records against token and composer budgets", () => {
  const plusCapabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
  const dense = "a!b@c#d$e%f^g&h*".repeat(3_750);
  const sparse = "x".repeat(dense.length);
  // Four records still exceed the 1,048,572-char composer cap, so token-only balancing would be unsafe.
  const whitespace = " ".repeat(300_000);

  for (const contents of [
    [dense, dense, sparse, sparse, dense, sparse],
    [dense, dense, whitespace, whitespace, whitespace, whitespace],
  ]) {
    const compiled = compileChatGptWebPrompt(request(contents.map((content, index) => ({
      role: "user" as const,
      content,
      timestamp: index + 1,
    }))), plusCapabilities, undefined, { multipartParts: 3 });
    const records = multipartRecords(compiled.multipart!.parts);
    expect(records).toEqual([
      { kind: "system", system_index: 0, content: "preserve-system" },
      ...contents.map((content, message_index) => ({
        kind: "message" as const,
        message_index,
        message: { role: "user", content },
      })),
    ]);

    const transactionId = `ctx_${"5".repeat(32)}`;
    const messages = [
      ...compiled.multipart!.parts.slice(0, -1).map((payload, index) => (
        formatChatGptWebMultipartStage(payload, transactionId, index + 1, 3).text
      )),
      formatChatGptWebMultipartCommit(compiled.multipart!, transactionId),
    ];
    const tokenBudget = resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_MODEL_ID, "high", plusCapabilities);
    const charBudget = resolveChatGptWebTransportLimits(CHATGPT_WEB_MODEL_ID, "high", plusCapabilities)
      .browserComposerCharLimit!;
    expect(Math.max(...messages.map(message => estimateTokens(message)))).toBeLessThanOrEqual(tokenBudget);
    expect(Math.max(...messages.map(message => message.length))).toBeLessThanOrEqual(charBudget);
  }
}, 20_000);

test("multipart compiler reserves image tokens from the final part budget", () => {
  const plusCapabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
  const baseBudget = resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_MODEL_ID, "high", plusCapabilities);
  const ordinaryImageReserve = chatGptWebImageTokenReserve();
  expect(baseBudget - resolveChatGptWebMessageTokenBudget(
    CHATGPT_WEB_MODEL_ID,
    "high",
    plusCapabilities,
    ordinaryImageReserve,
  )).toBe(ordinaryImageReserve);

  const dense = "a!b@c#d$e%f^g&h*".repeat(90);
  const compileWithDetail = (detail: string) => compileChatGptWebPrompt(request(
    Array.from({ length: 80 }, (_unused, index) => ({
      role: "user" as const,
      content: index === 0
        ? [
          { type: "text" as const, text: dense },
          { type: "image" as const, imageUrl: "data:image/png;base64,AA==", detail },
        ]
        : dense,
      timestamp: index + 1,
    })),
  ), plusCapabilities, undefined, { multipartParts: 2 });

  const ordinary = compileWithDetail("low");
  const original = compileWithDetail("original");
  expect(ordinary.images).toHaveLength(1);
  expect(original.images).toHaveLength(1);
  const ordinaryFinalRecords = (JSON.parse(ordinary.multipart!.parts[1]!) as { records: unknown[] }).records.length;
  const originalFinalRecords = (JSON.parse(original.multipart!.parts[1]!) as { records: unknown[] }).records.length;
  expect(originalFinalRecords).toBeLessThan(ordinaryFinalRecords);
});

test("an oversized single tool result is chunked and reconstructs byte-for-byte", () => {
  const original = `tool-result-${"z".repeat(45_000)}-tail`;
  const parsed = request([
    {
      role: "toolResult",
      toolCallId: "call_oversized",
      toolName: "exec_command",
      content: original,
      isError: false,
      timestamp: 1,
    },
    { role: "user", content: "finish", timestamp: 2 },
  ]);
  const maxMessageChars = 16_000;
  const compiled = compileChatGptWebPromptWithinPageCapacity(parsed, capabilities, undefined, { maxMessageChars });
  expect(compiled.multipart).toBeDefined();
  expect(compiled.multipart!.parts.length).toBeGreaterThan(3);
  for (const message of compiledChatGptWebMessages(compiled)) {
    expect(message.length).toBeLessThanOrEqual(maxMessageChars);
  }

  const records = multipartRecords(compiled.multipart!.parts);
  const messageChunks = records.filter(record => record.message_index === 0);
  expect(messageChunks.length).toBeGreaterThan(1);
  expect(messageChunks.map(record => record.chunk?.index)).toEqual(
    Array.from({ length: messageChunks.length }, (_unused, index) => index + 1),
  );
  expect(messageChunks.every(record => record.chunk?.total === messageChunks.length)).toBeTrue();
  expect(reconstructChunkedMessage(records, 0)).toEqual({
    role: "tool_result",
    tool_call_id: "call_oversized",
    tool_name: "exec_command",
    is_error: false,
    content: original,
  });
});

test("array content splits on item boundaries and can split one oversized text item without moving images", () => {
  const longText = `array-head-${"a".repeat(28_000)}-end`;
  const parsed = request([{
    role: "user",
    content: [
      { type: "text", text: longText },
      { type: "image", imageUrl: "data:image/png;base64,AA==" },
      { type: "text", text: "after-image" },
    ],
    timestamp: 1,
  }]);
  const maxMessageChars = 13_000;
  const compiled = compileChatGptWebPromptWithinPageCapacity(parsed, capabilities, undefined, { maxMessageChars });
  expect(compiled.multipart).toBeDefined();
  expect(compiled.images.map(image => image.ref)).toEqual(["codex-input-image-1"]);
  for (const message of compiledChatGptWebMessages(compiled)) {
    expect(message.length).toBeLessThanOrEqual(maxMessageChars);
  }

  const records = multipartRecords(compiled.multipart!.parts);
  const chunks = records.filter(record => record.message_index === 0);
  expect(chunks.some(record => record.chunk?.content_item?.index === 0)).toBeTrue();
  expect(reconstructChunkedMessage(records, 0)).toEqual({
    role: "user",
    content: [
      { type: "text", text: longText },
      { type: "image_attachment", attachment_ref: "codex-input-image-1" },
      { type: "text", text: "after-image" },
    ],
  });
});

test("contexts that already fit the legacy two-part transport keep identical payloads and gain an explicit chunk contract", () => {
  const parsed = request(Array.from({ length: 12 }, (_unused, index) => ({
    role: "user" as const,
    content: `capacity-message-${index}-${"x".repeat(850)}`,
    timestamp: index + 1,
  })));
  const legacy = compileChatGptWebPrompt(parsed, capabilities, undefined, { multipartParts: 2 });
  const limit = compiledChatGptWebMaxMessageChars(legacy);
  const inline = compileChatGptWebPrompt(parsed, capabilities);
  expect(compiledChatGptWebMaxMessageChars(inline)).toBeGreaterThan(limit);

  const automatic = compileChatGptWebPromptWithinPageCapacity(parsed, capabilities, undefined, {
    maxMessageChars: limit,
  });
  expect(automatic.multipart?.parts).toEqual(legacy.multipart?.parts);
  expect(automatic.multipart?.commit).toContain("chunk.index");
  expect(automatic.multipart?.commit).toContain("Records without chunk");
});

test("multipart transport reports the exact required part count when the twelve-part ceiling is exceeded", () => {
  const parsed = request(Array.from({ length: 13 }, (_unused, index) => ({
    role: "user" as const,
    content: `ceiling-record-${index}-${"q".repeat(8_000)}`,
    timestamp: index + 1,
  })));
  parsed.context.systemPrompt = [];
  const twelve = compileChatGptWebPrompt(parsed, capabilities, undefined, { multipartParts: 12 });
  const recordCounts = twelve.multipart!.parts.map(part => (
    JSON.parse(part) as { records: unknown[] }
  ).records.length);
  const messages = compiledChatGptWebMessages(twelve);
  const singleRecordMax = Math.max(...messages.filter((_message, index) => recordCounts[index] === 1).map(message => message.length));
  const multiRecordMin = Math.min(...messages.filter((_message, index) => recordCounts[index]! > 1).map(message => message.length));
  expect(singleRecordMax).toBeLessThan(multiRecordMin);
  const maxMessageChars = Math.floor((singleRecordMax + multiRecordMin) / 2);

  expect(() => compileChatGptWebPromptWithinPageCapacity(parsed, capabilities, undefined, { maxMessageChars }))
    .toThrow(/requires 13 multipart parts.*maximum is 12|maximum is 12.*requires 13 multipart parts/i);
});

test("multipart capacity diagnostics bound repartition attempts above the twelve-part ceiling", () => {
  const parsed = request(Array.from({ length: 60 }, (_unused, index) => ({
    role: "user" as const,
    content: `diagnostic-record-${index}-${"z".repeat(5_000)}`,
    timestamp: index + 1,
  })));
  parsed.context.systemPrompt = [];
  const repartition = spyOn(promptModule, "repartitionChatGptWebMultipartParts");

  try {
    expect(() => compileChatGptWebPromptWithinPageCapacity(parsed, capabilities, undefined, {
      maxMessageChars: 10_000,
    })).toThrow(/requires 61 multipart parts.*maximum is 12|maximum is 12.*requires 61 multipart parts/i);
    expect(repartition).toHaveBeenCalled();
    // The legacy linear diagnostic made 119 repartition calls for this same fixture.
    expect(repartition.mock.calls.length).toBeLessThanOrEqual(40);
  } finally {
    repartition.mockRestore();
  }
});

test("a payload many pages past inline still reconstructs byte-for-byte", () => {
  // This size makes the compiler start at its arithmetic floor instead of walking up from two
  // parts. The shortcut must produce a split that fits and loses nothing.
  const original = `tool-result-${"w".repeat(200_000)}-tail`;
  const parsed = request([
    {
      role: "toolResult",
      toolCallId: "call_many_pages",
      toolName: "exec_command",
      content: original,
      isError: false,
      timestamp: 1,
    },
    { role: "user", content: "finish", timestamp: 2 },
  ]);
  const maxMessageChars = 20_000;
  const compiled = compileChatGptWebPromptWithinPageCapacity(parsed, capabilities, undefined, { maxMessageChars });
  expect(compiled.multipart!.parts.length).toBeGreaterThan(3);
  for (const message of compiledChatGptWebMessages(compiled)) {
    expect(message.length).toBeLessThanOrEqual(maxMessageChars);
  }
  const records = multipartRecords(compiled.multipart!.parts);
  const messageChunks = records.filter(record => record.message_index === 0);
  expect(messageChunks.map(record => record.chunk?.index)).toEqual(
    Array.from({ length: messageChunks.length }, (_unused, index) => index + 1),
  );
  expect(reconstructChunkedMessage(records, 0)).toEqual({
    role: "tool_result",
    tool_call_id: "call_many_pages",
    tool_name: "exec_command",
    is_error: false,
    content: original,
  });
});
