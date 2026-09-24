import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  compiledChatGptWebMessages,
  compiledChatGptWebMessagesForCapacityDiagnostic,
  compiledChatGptWebMaxMessageChars,
  DEFAULT_CHATGPT_WEB_MAX_MESSAGE_CHARS,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import { resolveChatGptWebMessageTokenBudget } from "../../chatgpt-web-models";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
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
  extends Omit<
    CompileChatGptWebPromptOptions,
    "multipartParts" | "experimentalMultipartParts" | "multipartRecordWeightCache" | "preserveCompactionHistory"
  > {
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
  const messages = compiledChatGptWebMessagesForCapacityDiagnostic(template);
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
  return Math.max(...compiledChatGptWebMessagesForCapacityDiagnostic(candidate).map(message => message.length))
    <= maxMessageChars ? candidate : undefined;
}

function multipartDiagnosticCanFit(
  source: CompiledChatGptWebPrompt,
  totalParts: number,
  maxMessageChars: number,
): boolean {
  if (repartitionForPageCapacity(source, totalParts, maxMessageChars, false)) return true;
  return repartitionForPageCapacity(source, totalParts, maxMessageChars, true) !== undefined;
}

function multipartEmptyTemplateCanFit(
  source: CompiledChatGptWebPrompt,
  totalParts: number,
  maxMessageChars: number,
): boolean {
  return Math.max(...compiledChatGptWebMessagesForCapacityDiagnostic(multipartTemplate(source, totalParts))
    .map(message => message.length)) <= maxMessageChars;
}

function multipartDiagnosticUpperBound(
  source: CompiledChatGptWebPrompt,
  sourceChars: number,
  maxMessageChars: number,
): number {
  // For every diagnostic candidate (13+ parts), each SHA-256 manifest entry needs at least
  // 69 characters ("1/13:" + 64 hex chars) plus its separating space. Once 70*N - 1 alone
  // exceeds the browser-message limit, even an empty final payload cannot fit.
  const manifestBound = Math.floor((maxMessageChars + 1) / 70);
  if (manifestBound < CHATGPT_WEB_MULTIPART_MAX_PARTS + 1) return manifestBound;
  const candidateBound = Math.min(
    Math.max(CHATGPT_WEB_MULTIPART_MAX_PARTS + 1, sourceChars + 2),
    manifestBound,
  );
  let low = CHATGPT_WEB_MULTIPART_MAX_PARTS + 1;
  let high = candidateBound;
  let found: number = CHATGPT_WEB_MULTIPART_MAX_PARTS;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (multipartEmptyTemplateCanFit(source, candidate, maxMessageChars)) {
      found = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return found;
}

function findRequiredMultipartParts(
  source: CompiledChatGptWebPrompt,
  maxMessageChars: number,
  upperBound: number,
): number | undefined {
  let bandStart = CHATGPT_WEB_MULTIPART_MAX_PARTS + 1;
  while (bandStart <= upperBound) {
    // Sufficiency is monotone while total_parts keeps the same decimal width: existing stage
    // envelopes keep the same size, the old final part becomes a roomier normal stage, and the new
    // final part may remain empty. Decimal-width boundaries are searched separately because 99 ->
    // 100 grows both the payload JSON and transport wrappers and can reduce per-part capacity.
    const nextDecimalWidth = 10 ** String(bandStart).length;
    const bandEnd = Math.min(upperBound, nextDecimalWidth - 1);
    let low = bandStart;
    let high = bandEnd;
    let found: number | undefined;
    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      if (multipartDiagnosticCanFit(source, candidate, maxMessageChars)) {
        found = candidate;
        high = candidate - 1;
      } else {
        low = candidate + 1;
      }
    }
    if (found !== undefined) return found;
    bandStart = bandEnd + 1;
  }
  return undefined;
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
  const multipartRecordWeightCache = new Map<string, { tokens: number; chars: number }>();
  const baseOptions = {
    ...compileOptions,
    multipartRecordWeightCache,
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

  // A text attachment avoids staging an instruction-heavy first turn in multiple browser
  // messages. Keep multipart as the fallback when the file, attachments or model budget cannot
  // carry the complete context. Native compaction retains its existing transport semantics.
  if (capabilities.localToolsEnabled && options.experimentalSkillAttachments === true && !parsed._compactionRequest) {
    const fileCandidate = compileChatGptWebPrompt(parsed, capabilities, turnToken, {
      ...baseOptions,
      contextAsFile: true,
    });
    const files = fileCandidate.skillFiles ?? [];
    const contextFile = files.at(-1);
    const effort = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities).effort;
    if (contextFile
      && files.length + fileCandidate.images.length <= 10
      && Buffer.byteLength(contextFile.text, "utf8") <= 20_000_000
      && compiledChatGptWebMaxMessageChars(fileCandidate) <= maxMessageChars
      && estimateCompiledChatGptWebMessageTokens(fileCandidate, parsed.modelId)
        <= resolveChatGptWebMessageTokenBudget(
          CHATGPT_WEB_MODEL_ID, effort, capabilities, estimateChatGptWebImageTokens(fileCandidate),
        )) return fileCandidate;
  }

  // Every part of an N-way split still carries the inline payload divided N ways plus its own
  // envelope, so no split below inlineChars/maxMessageChars can fit. Probing that floor first turns
  // a twelve-part turn's eleven rejected full compiles into one. A probe that does not fit falls
  // through to the original ascending search, so the part count finally selected, the repartition
  // fallbacks and every diagnostic below are unchanged.
  const capacityFloor = Math.min(
    CHATGPT_WEB_MULTIPART_MAX_PARTS,
    Math.max(2, Math.floor(inlineChars / maxMessageChars)),
  );
  if (capacityFloor > 2) {
    const probe = compileChatGptWebPrompt(parsed, capabilities, turnToken, {
      ...baseOptions,
      multipartParts: capacityFloor,
    });
    if (compiledChatGptWebMaxMessageChars(probe) <= maxMessageChars) return probe;
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
  const diagnosticUpperBound = multipartDiagnosticUpperBound(sourceMultipart, sourceChars, maxMessageChars);
  const requiredParts = findRequiredMultipartParts(sourceMultipart, maxMessageChars, diagnosticUpperBound);
  if (requiredParts !== undefined) throw multipartPartLimitError(requiredParts, maxMessageChars);

  throw capacityError(lastChars, maxMessageChars, "automatic");
}
