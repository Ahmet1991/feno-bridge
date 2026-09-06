import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  compiledChatGptWebMessages,
  compiledChatGptWebMaxMessageChars,
  DEFAULT_CHATGPT_WEB_MAX_MESSAGE_CHARS,
} from "./input-tokens";
import { CHATGPT_WEB_LUNA_MODEL_ID, type ChatGptWebCapabilities } from "./model";
import {
  CHATGPT_WEB_MULTIPART_MAX_PARTS,
  compileChatGptWebPrompt,
  repartitionChatGptWebMultipartParts,
  type CompileChatGptWebPromptOptions,
  type CompiledChatGptWebPrompt,
  type ChatGptWebMultipartParts,
} from "./prompt";

export { DEFAULT_CHATGPT_WEB_MAX_MESSAGE_CHARS } from "./input-tokens";

export interface ChatGptWebCapacityCompileOptions
  extends Omit<CompileChatGptWebPromptOptions, "multipartParts" | "experimentalMultipartParts" | "preserveCompactionHistory"> {
  maxMessageChars?: number;
}

function capacityError(
  actualChars: number,
  maxMessageChars: number,
  transport: "automatic" | "manual" | "luna",
): ChatGptWebAdapterError {
  const actual = actualChars.toLocaleString("en-US");
  const limit = maxMessageChars.toLocaleString("en-US");
  const transportGuidance = transport === "manual"
    ? " Zero Risk cannot split the prompt into multiple browser messages."
    : transport === "luna"
      ? " Luna cannot use multipart browser transport because its staged transcript shares one browser input budget."
      : ` Even multipart browser transport up to ${CHATGPT_WEB_MULTIPART_MAX_PARTS} parts cannot keep every message within the configured page limit.`;
  return new ChatGptWebAdapterError(
    `ChatGPT browser prompt requires ${actual} characters in one message, above the configured page limit of ${limit}.${transportGuidance}`
      + " Reduce or compact the Codex context, or raise chatGptWebMaxMessageChars only after verifying this machine's ChatGPT page capacity.",
    {
      status: 413,
      errorType: "invalid_request_error",
      code: "browser_message_too_large",
      retryable: false,
    },
  );
}

function multipartPartLimitError(requiredParts: number, maxMessageChars: number): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT browser transport requires ${requiredParts.toLocaleString("en-US")} multipart parts to keep every message within the configured page limit of ${maxMessageChars.toLocaleString("en-US")} characters, but the maximum is ${CHATGPT_WEB_MULTIPART_MAX_PARTS}. Compact the Codex context before retrying so ChatGPT does not silently lose staged context.`,
    {
      status: 413,
      errorType: "invalid_request_error",
      code: "browser_message_too_large",
      retryable: false,
    },
  );
}

function withMultipartParts(
  compiled: CompiledChatGptWebPrompt,
  parts: ChatGptWebMultipartParts,
): CompiledChatGptWebPrompt {
  if (!compiled.multipart) throw new Error("ChatGPT multipart candidate is missing its transport envelope");
  const multipart = { ...compiled.multipart, parts };
  return { ...compiled, text: multipart.commit, multipart };
}

function multipartTemplate(
  source: CompiledChatGptWebPrompt,
  totalParts: number,
): CompiledChatGptWebPrompt {
  if (!source.multipart) throw new Error("ChatGPT multipart source is missing its transport envelope");
  const parts = Array.from({ length: totalParts }, (_unused, index) => JSON.stringify({
    version: 1,
    part_index: index + 1,
    total_parts: totalParts,
    records: [],
  }));
  return withMultipartParts(source, parts);
}

function multipartPayloadCharLimits(
  template: CompiledChatGptWebPrompt,
  maxMessageChars: number,
): number[] {
  if (!template.multipart) throw new Error("ChatGPT multipart template is missing its parts");
  const messages = compiledChatGptWebMessages(template);
  return template.multipart.parts.map((payload, index) => (
    maxMessageChars - (messages[index]!.length - payload.length)
  ));
}

function multipartEnvelopeCanFit(
  source: CompiledChatGptWebPrompt,
  totalParts: number,
  maxMessageChars: number,
): boolean {
  const template = multipartTemplate(source, totalParts);
  return multipartPayloadCharLimits(template, maxMessageChars).every(limit => limit > 0);
}

function repartitionForPageCapacity(
  source: CompiledChatGptWebPrompt,
  totalParts: number,
  maxMessageChars: number,
  splitOversizedRecords: boolean,
): CompiledChatGptWebPrompt | undefined {
  if (!source.multipart) throw new Error("ChatGPT multipart source is missing its parts");
  const template = multipartTemplate(source, totalParts);
  const payloadLimits = multipartPayloadCharLimits(template, maxMessageChars);
  const parts = repartitionChatGptWebMultipartParts(
    source.multipart.parts,
    totalParts,
    payloadLimits,
    splitOversizedRecords,
  );
  if (!parts) return undefined;
  const candidate = withMultipartParts(source, parts);
  return compiledChatGptWebMaxMessageChars(candidate) <= maxMessageChars ? candidate : undefined;
}

export function compileChatGptWebPromptWithinPageCapacity(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  turnToken?: string,
  options: ChatGptWebCapacityCompileOptions = {},
): CompiledChatGptWebPrompt {
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_CHATGPT_WEB_MAX_MESSAGE_CHARS;
  if (!Number.isSafeInteger(maxMessageChars) || maxMessageChars <= 0) {
    throw new Error("ChatGPT browser maxMessageChars must be a positive safe integer");
  }
  const { maxMessageChars: _ignored, ...compileOptions } = options;
  const baseOptions = {
    ...compileOptions,
    preserveCompactionHistory: true,
  } satisfies CompileChatGptWebPromptOptions;
  const inline = compileChatGptWebPrompt(parsed, capabilities, turnToken, baseOptions);
  const inlineChars = compiledChatGptWebMaxMessageChars(inline);
  if (inlineChars <= maxMessageChars) return inline;

  if (options.manualControl === true) {
    throw capacityError(inlineChars, maxMessageChars, "manual");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw capacityError(inlineChars, maxMessageChars, "luna");
  }

  let lastChars = inlineChars;
  let sourceMultipart: CompiledChatGptWebPrompt | undefined;
  for (let multipartParts = 2; multipartParts <= CHATGPT_WEB_MULTIPART_MAX_PARTS; multipartParts += 1) {
    const candidate = compileChatGptWebPrompt(parsed, capabilities, turnToken, {
      ...baseOptions,
      multipartParts,
    });
    sourceMultipart ??= candidate;
    lastChars = compiledChatGptWebMaxMessageChars(candidate);
    if (lastChars <= maxMessageChars) return candidate;
    const repartitioned = repartitionForPageCapacity(candidate, multipartParts, maxMessageChars, false);
    if (repartitioned) return repartitioned;
  }

  if (!sourceMultipart?.multipart) throw capacityError(lastChars, maxMessageChars, "automatic");
  for (let multipartParts = 2; multipartParts <= CHATGPT_WEB_MULTIPART_MAX_PARTS; multipartParts += 1) {
    const chunked = repartitionForPageCapacity(sourceMultipart, multipartParts, maxMessageChars, true);
    if (chunked) return chunked;
  }

  // The final commit wrapper includes the manifest for every part, so its fixed overhead only grows
  // as more parts are added. If the smallest multipart envelope cannot fit at all, no larger N can
  // create payload room and an exact required-part diagnostic does not exist.
  if (!multipartEnvelopeCanFit(sourceMultipart, 2, maxMessageChars)) {
    throw capacityError(lastChars, maxMessageChars, "automatic");
  }

  const sourceChars = sourceMultipart.multipart.parts.reduce((total, part) => total + part.length, 0);
  const diagnosticUpperBound = Math.min(Math.max(CHATGPT_WEB_MULTIPART_MAX_PARTS + 1, sourceChars + 2), 4_096);
  for (
    let requiredParts = CHATGPT_WEB_MULTIPART_MAX_PARTS + 1;
    requiredParts <= diagnosticUpperBound;
    requiredParts += 1
  ) {
    const wholeRecords = repartitionForPageCapacity(sourceMultipart, requiredParts, maxMessageChars, false);
    if (wholeRecords) throw multipartPartLimitError(requiredParts, maxMessageChars);
    const chunked = repartitionForPageCapacity(sourceMultipart, requiredParts, maxMessageChars, true);
    if (chunked) throw multipartPartLimitError(requiredParts, maxMessageChars);
  }

  throw capacityError(lastChars, maxMessageChars, "automatic");
}
