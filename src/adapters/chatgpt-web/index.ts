import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import {
  cancelLauncherManualTurn,
  endLauncherManualTurn,
  LauncherBrowserTurnCancelledError,
  LauncherManualTurnFailedError,
  LauncherManualTurnTimedOutError,
  markLauncherManualTurnStarted,
  releaseLauncherRetainedConversation,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
  type LauncherManualTurnEnd,
  type LauncherManualTurnOwner,
  type LauncherManualTurnStart,
} from "../../launcher-browser-host";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { toolImageReachesRunningMessage, toolImagesNeedingDelivery } from "./tool-images";
import { describeCauseChain } from "../../lib/errors";
import { ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";
import {
  compileChatGptWebPromptWithinPageCapacity,
  DEFAULT_CHATGPT_WEB_MAX_MESSAGE_CHARS,
} from "./capacity";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity, priorChatGptAbortedTurnIds } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { CHATGPT_MAX_INPUT_IMAGES, chatGptReadOnlyContextWarning, chatGptTurnTokenInstruction, countChatGptContextImages, type ChatGptWebPromptImage } from "./prompt";
import {
  callObservesWindow,
  isPolicyStop,
  toolResultHasImage,
  toolResultText,
  WindowRecoveryTracker,
} from "./window-recovery";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import {
  TurnBroker,
  type BrokerToolRequest,
  type BrokerToolResult,
  type CompactionPendingToolRequest,
  type TurnBrokerOwner,
} from "./turn-broker";
import { stageCompactionContinuationPendingWork } from "./compaction-continuation";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptInstructionLineage, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnRoundKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import { backfillEmptyToolSearchResults } from "./tool-search-backfill";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "./compaction-handoff";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "./conversation-key";

const windowRecoveryBySession = new WeakMap<ChatGptTurnSession, WindowRecoveryTracker>();
/**
 * Images a local tool returned mid-turn, kept rather than counted: a follow-up turn can attach
 * them, which is the only way one reaches the model at all.
 */
const unshownImagesBySession = new WeakMap<ChatGptTurnSession, ChatGptWebPromptImage[]>();
const activeContinuationImagesBySession = new WeakMap<ChatGptTurnSession, ChatGptWebPromptImage[]>();
const lastCompletedAnswerBySession = new WeakMap<ChatGptTurnSession, string>();
/** The image continuation phase whose answer has already been set apart; see separatePhaseText. */
const separatedPhaseBySession = new WeakMap<ChatGptTurnSession, number>();
/** Sessions already given one delivery turn, so a long tool round cannot spawn one per image. */
const imagesDeliveredSessions = new WeakSet<ChatGptTurnSession>();
/**
 * ChatGPT's own attachment-limit notice, once an image continuation met it. A delivery turn needs
 * the same attachments, so it is not attempted, and the user is told why the images stayed unseen.
 */
const attachmentLimitBySession = new WeakMap<ChatGptTurnSession, string>();

function attachmentLimitFinalNotice(count: number, notice: string): string {
  const cause = notice
    ? `ChatGPT'nin dosya eki limiti dolu ("${notice}")`
    : "ChatGPT dosya eklerinin hiçbirini kabul etmedi (büyük olasılıkla dosya eki limiti dolu)";
  return `\n\n[Feno Bridge] ${cause}; yerel araçların döndürdüğü ${count} görüntü modele gösterilemedi,`
    + " bu görüntülere dayanan görsel bir inceleme doğrulanmış değil. Limit açılınca yeni bir turda devam et.";
}

/**
 * Tool images a follow-up message attached, per retained conversation (sha256 of the image URL).
 * The next Codex turn carries the previous round's unseen tool images into its own attachments;
 * one a follow-up already attached is in that conversation, and uploading it again only spent the
 * account's attachment limit (every image went up twice on 30.09).
 */
const attachedToolImagesByConversation = new Map<string, Set<string>>();
const MAX_TRACKED_IMAGE_CONVERSATIONS = 64;

function toolImageDigest(imageUrl: string): string {
  return createHash("sha256").update(imageUrl).digest("hex");
}

function recordAttachedToolImages(conversationKey: string, images: ReadonlyArray<{ imageUrl: string }>): void {
  let attached = attachedToolImagesByConversation.get(conversationKey);
  if (!attached) {
    attached = new Set();
    attachedToolImagesByConversation.set(conversationKey, attached);
    while (attachedToolImagesByConversation.size > MAX_TRACKED_IMAGE_CONVERSATIONS) {
      const oldest = attachedToolImagesByConversation.keys().next();
      if (oldest.done) break;
      attachedToolImagesByConversation.delete(oldest.value);
    }
  }
  for (const image of images) attached.add(toolImageDigest(image.imageUrl));
}

function sessionUnshownImageNotice(session: ChatGptTurnSession): string | undefined {
  const count = (unshownImagesBySession.get(session) ?? []).length;
  const limit = attachmentLimitBySession.get(session);
  return count > 0 && limit !== undefined
    ? attachmentLimitFinalNotice(count, limit)
    : unshownImageFinalNotice(count);
}

const MAX_IMAGE_CONTINUATION_PHASES = 4;

// The v5.0.48 wording ("if it is visible to you, use it") made the model reopen the same files: 32
// view_image calls for 12 images on 28 Sep, against 12 with this one. Keep it.
const BROKER_IMAGE_NOTICE = "[Feno Bridge] This tool returned an image that the already-running ChatGPT message cannot show you, and calling the tool again will not show it either. The image will be attached to a new message as soon as you finish this one. If you need to see it, do not guess and do not retry: end this message now with a short note, and continue once the image arrives.";

function imageContinuationTraceId(parentTraceId: string, phase: number): string {
  return createHash("sha256")
    .update(`${parentTraceId}:image-continuation:${phase}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * What a delivery turn says. The images ride on this message as real attachments. Until late
 * September that was the one path by which a tool's image reached the model; on 28 Sep ChatGPT read
 * all twelve view_image results inside the running message, and the delivery turn then wrote the
 * whole answer a second time. So it verifies rather than answers again: an answer that already
 * matches the images gets one short sentence, and only what the images change is written out.
 */
// "Compare with these attachments" (v5.0.48) read as "open them again": each follow-up called
// view_image once more, whose new image started another follow-up, four phases deep (28 Sep). The
// attachments are the images; saying so, and forbidding the reopen, ends the chain at one phase.
const DELIVERED_IMAGES_PROMPT = "[Feno Bridge] Önceki araç çağrılarının döndürdüğü görüntü(ler) bu"
  + " mesaja ek olarak bağlandı; bunlar o görüntülerin kendisi, onları yeniden açmak için araç"
  + " çağırma. Önceki cevabın bu görüntülerle uyuşuyorsa onu tekrarlama; yalnızca bunu doğrulayan tek"
  + " kısa cümle yaz. Görüntüleri göremediğin için yanıtlayamadığın, eksik ya da yanlış kalan bir şey"
  + " varsa yalnızca onu yanıtla veya düzelt. Ekte göremediğin bir şey varsa göremediğini söyle.";

function unshownImageFinalNotice(count: number): string | undefined {
  return count > 0
    ? `\n\n[Feno Bridge] Yerel araçların döndürdüğü ${count} görüntü bu tura eklenemedi; bu görüntülere dayanan görsel bir inceleme doğrulanmış değil. Görüntüleri ekleyip incelemek için yeni bir turda devam et.`
    : undefined;
}

/**
 * The newest tool images, each named for the attachment it becomes. Refs used to be numbered from
 * the pending list's length, which stops growing at the cap, so the twelfth screenshot of a round
 * reused the eleventh's name. ChatGPT then showed two attachments with one name and the upload
 * check could not tell them apart (28 Sep: "did not accept all prompt attachments" on a ten-image
 * continuation). Numbering whatever is kept makes every name unique by construction.
 */
export function newestToolImages(images: Array<{ imageUrl: string; detail?: string }>): ChatGptWebPromptImage[] {
  // The same screenshot opened again is one attachment, kept at its latest position: on 30.09 one
  // continuation uploaded four copies of preview.png.
  const latest = new Map<string, { imageUrl: string; detail?: string }>();
  for (const image of images) {
    latest.delete(image.imageUrl);
    latest.set(image.imageUrl, image);
  }
  return [...latest.values()].slice(-CHATGPT_MAX_INPUT_IMAGES).map((image, index) => ({
    ...image,
    ref: `codex-tool-image-${index + 1}`,
  }));
}

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ChatGptWebAdapterError) return signal.reason;
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // Observe the abandoned operation so its later rejection is not an unhandled one.
    promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function cancellableBrowserTurn(
  run: Promise<string>,
  controller: AbortController,
): { browser: Promise<string>; physicalSettlement: Promise<void>; cancel: (reason?: Error) => void } {
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationRejected = false;
  return {
    // Cancellation wins immediately even while the detached Playwright helper is still unwinding.
    // The helper keeps the same abort signal and remains responsible for its normal end/cleanup
    // handshake, but the Codex Responses turn no longer waits on that process cleanup.
    browser: Promise.race([run, cancellation]),
    // `browser` is the fast client-facing result. Replacement ownership must wait for the actual
    // worker promise, whose finally block completes the launcher /turn/end handshake.
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      // Explicit targeted cancellation ends the Codex Responses turn immediately. Generic
      // retirement (client disconnect or compaction replacement) still waits for the helper's
      // cleanup handshake before a replacement browser may start.
      if (reason && !cancellationRejected) {
        cancellationRejected = true;
        rejectCancellation(reason);
      }
    },
  };
}

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

const launcherZeroRiskManualControl: ChatGptZeroRiskManualControl = {
  start: startLauncherManualTurn,
  waitSent: waitForLauncherManualSent,
  waitTerminal: waitForLauncherManualTerminal,
  markStarted: markLauncherManualTurnStarted,
  end: endLauncherManualTurn,
  cancel: cancelLauncherManualTurn,
};

function safeManualAdapterError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof ChatGptWebAdapterError) return error;
  if (error instanceof LauncherManualTurnTimedOutError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 408,
      errorType: "invalid_request_error",
      code: "manual_handoff_timeout",
      retryable: false,
    });
  }
  if (error instanceof LauncherBrowserTurnCancelledError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  if (error instanceof LauncherManualTurnFailedError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 502,
      errorType: "server_error",
      code: "manual_launcher_failed",
      retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeManualTerminalError(status: "cancelled" | "failed"): ChatGptWebAdapterError {
  if (status === "cancelled") {
    return new ChatGptWebAdapterError("The Zero Risk browser turn was cancelled in the Launcher", {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  return new ChatGptWebAdapterError("The Zero Risk browser tab failed before ChatGPT completed the turn", {
    status: 502,
    errorType: "server_error",
    code: "manual_launcher_failed",
    retryable: false,
  });
}

export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  const namespace = chatGptWebExecutionNamespace(provider);
  // The logical response key survives compaction so a final answer that won the handoff race
  // can still be replayed. A new physical browser owner must instead belong to the new context
  // epoch; otherwise Zero Risk correctly rejects it against the previous owner's completion.
  const conversation = parsed._compactionRequest ? undefined : chatGptConversationKey(parsed, namespace);
  return createHash("sha256")
    .update(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)
    .update(conversation ? `:${conversation}` : "")
    .digest("hex")
    .slice(0, 12);
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  // An image the running message cannot show is left out: with it in the result the model read
  // neither the image nor the note beside it, and re-opened the image five times (30.09).
  return content.flatMap((part): unknown[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (!toolImageReachesRunningMessage(part.imageUrl)) return [];
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return [{ type: "image", data: parsed.base64, mimeType: parsed.mediaType }];
    return [{ type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" }];
  });
}

function brokerResult(message: CodexToolResultMessage, recoveryNote?: string): BrokerToolResult {
  const content = brokerContent(message.content);
  const imageNotice = toolImagesNeedingDelivery(message.content).length > 0 ? BROKER_IMAGE_NOTICE : undefined;
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  // Derived from the tool's own text only. A recovery note is appended as its own part below, so
  // the original output stays byte-for-byte intact and a JSON result still parses.
  const structured = structuredContent(text);
  return {
    content: [
      ...content,
      ...(recoveryNote !== undefined ? [{ type: "text", text: recoveryNote }] : []),
      ...(imageNotice !== undefined ? [{ type: "text", text: imageNotice }] : []),
    ],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

/**
 * An image continuation's answer streams into the message that already holds the previous phase's
 * answer, so its first text needs a paragraph break. 27 Sep 23:57 UTC: without
 * one the live answer read "... bu sayıma girmez.Abim, şimdi görüntüler net görünüyor." The break goes
 * once per phase, before the phase's first non-empty text: a phase that runs tools resumes in a new
 * Codex message, which must not start with one.
 */
export function separatePhaseText(
  deltas: string[],
  phase: number,
  separatedPhase: number | undefined,
  previousAnswer: string | undefined,
): { deltas: string[]; separatedPhase: number | undefined } {
  if (phase === 0 || separatedPhase === phase) return { deltas, separatedPhase };
  const first = deltas.findIndex(delta => delta.length > 0);
  if (first < 0) return { deltas, separatedPhase };
  const needsBreak = previousAnswer !== undefined
    && previousAnswer.trim().length > 0
    && !/^\s*\n/.test(deltas[first]!);
  return {
    deltas: needsBreak ? deltas.map((delta, index) => index === first ? `\n\n${delta}` : delta) : deltas,
    separatedPhase: phase,
  };
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (normalized instanceof ChatGptWebAdapterError) return normalized;
  const phase = session.runtime.submission?.phase;
  if (!phase || phase === "prepared") return normalized;
  const ambiguous = phase === "send_activated";
  // The turn is about to be reported by a message that deliberately says nothing about the cause,
  // and the `cause` attached below is never read: the round event carries only message, status,
  // errorType, code and retryable. Without this line the one failure that most needs explaining
  // leaves no trace anywhere, which is exactly what it did on the install that prompted this.
  //
  // stderr rather than the round event, because the operator needs the detail and the model does
  // not. The launcher captures it into launcher.jsonl under its usual redaction, and the traceId
  // ties it to the browser.turn_started / browser.turn_ended records already logged there.
  console.error(
    `[chatgpt-web] submitted turn failed (traceId=${session.traceId ?? "unknown"}, phase=${phase}): `
    + describeCauseChain(normalized),
  );
  if (normalized.stack) console.error(normalized.stack);
  return new ChatGptWebAdapterError(
    ambiguous
      ? "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing."
      : "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: {
    broker?: TurnBrokerOwner;
    zeroRiskManualControl?: ChatGptZeroRiskManualControl;
  } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const zeroRiskManualControl = dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl;
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalSkillAttachments = provider.chatgptWeb?.experimentalSkillAttachments;
  if (experimentalSkillAttachments !== undefined && typeof experimentalSkillAttachments !== "boolean") {
    throw new Error("ChatGPT skill attachments preference must be a boolean");
  }
  if (experimentalSkillAttachments && provider.chatgptWeb?.browserInteractionMode === "manual") {
    throw new Error("Skills as files is unavailable in Zero Risk mode");
  }
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const maxMessageChars = provider.chatgptWeb?.maxMessageChars ?? DEFAULT_CHATGPT_WEB_MAX_MESSAGE_CHARS;
  if (!Number.isSafeInteger(maxMessageChars) || maxMessageChars <= 0) {
    throw new Error("ChatGPT browser maxMessageChars must be a positive safe integer");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
      ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
      : undefined;
  if (manualInteraction) {
    if (!configuredCapabilities.localToolsEnabled) {
      throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
    }
    if (!retainedLauncherDescriptor) {
      throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
    }
  }
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: {
      onCompactionProgress?: (kind: "submitted" | "multipart" | "heartbeat") => void;
    } = {},
  ): ChatGptTurnRuntime => {
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) {
      throw new Error(
        manualInteraction
          ? "ChatGPT Zero Risk requires the Zero Risk Web model route"
          : "The Zero Risk Web model route requires ChatGPT Zero Risk interaction mode",
      );
    }
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const conversationKey = !parsed._compactionRequest
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && mode.localTools
      && retainedLauncherDescriptor
      ? chatGptConversationKey(checkpointInput.parsed, executionNamespace)
      : undefined;
    const resumeInput = conversationKey
      ? retainedConversationResumeRequest(
        checkpointInput.parsed,
        imageUrl => attachedToolImagesByConversation.get(conversationKey)?.has(toolImageDigest(imageUrl)) === true,
      )
      : undefined;
    const retainConversation = conversationKey !== undefined;
    const releaseRetainedConversation = conversationKey && retainedLauncherDescriptor
      ? async () => {
        await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
      }
      : undefined;
    const compileForCapacity = (
      input: CodexParsedRequest,
      turnToken?: string,
      manualControl = false,
    ) => {
      if (experimentalBiggerContext && input.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
        throw new Error(
          "Bigger Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget",
        );
      }
      return compileChatGptWebPromptWithinPageCapacity(
        input,
        turnCapabilities,
        turnToken,
        {
          captureLunaCheckpoint,
          experimentalSkillAttachments,
          maxMessageChars,
          ...(manualControl ? { manualControl: true as const } : {}),
        },
      );
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    let browserOwnerSettled = false;
    const trackBrowserOwner = (browser: Promise<string>): Promise<string> => browser.finally(() => {
      browserOwnerSettled = true;
    });
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const observedCapabilityTokens = new Set<string>();
    const observeCapabilityRetirement = (
      turnToken: string,
      externalProgress: ChatGptExternalTurnProgress,
    ): void => {
      if (observedCapabilityTokens.has(turnToken)) return;
      observedCapabilityTokens.add(turnToken);
      void broker.waitForRetirement(turnToken).then(
        () => {
          const retirement = new Error("Codex Native retired the turn binding before its tool work completed");
          externalProgress.retire(retirement);
          if (!browserOwnerSettled && !browserAbort.signal.aborted) browserAbort.abort(retirement);
        },
        error => {
          const failure = new Error("ChatGPT could not observe Codex Native turn retirement", {
            cause: error,
          });
          externalProgress.retire(failure);
          if (!browserAbort.signal.aborted) browserAbort.abort(failure);
        },
      );
    };
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    // A canonical compaction request is side-effect free and remains safe to rebuild after an
    // ambiguous browser send. Normal task prompts must never be replayed after Send activation.
    const submissionLifecycle = {
      ...(!parsed._compactionRequest ? {
        onSendActivated: () => { submission.phase = "send_activated" as const; },
      } : {}),
      onSubmitted: () => {
        if (!parsed._compactionRequest) submission.phase = "accepted";
        hooks.onCompactionProgress?.("submitted");
      },
    };
    const multipartProgressLifecycle = hooks.onCompactionProgress
      ? { onMultipartStageAcknowledged: () => hooks.onCompactionProgress!("multipart") }
      : {};
    const compactionHeartbeatLifecycle = parsed._compactionRequest
      ? {
        onHeartbeat: () => {
          if (hooks.onCompactionProgress) hooks.onCompactionProgress("heartbeat");
          else trace.push({
              kind: "commentary",
              text: "Context compaction is still running in ChatGPT…",
            });
        },
      }
      : {};
    if (manualRequest) {
      if (!environment) throw new Error("ChatGPT Zero Risk requires a trusted Codex environment");
      if (!retainedLauncherDescriptor) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
      const token = deferred<string>();
      const externalProgress = new ChatGptExternalTurnProgress();
      const surfaceNonce = randomBytes(32).toString("base64url");
      const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
      let tokenSettled = false;
      let activeToken: string | undefined;
      let launcherStarted = false;
      let launcherEnded = false;
      const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
        if (!launcherStarted || launcherEnded) return;
        await zeroRiskManualControl.end(retainedLauncherDescriptor, {
          ...owner,
          status,
          ...(status === "completed" && retainConversation ? { retain: true } : {}),
        });
        launcherEnded = true;
      };
      const runManual = async (): Promise<string> => {
        try {
          activeToken = await broker.registerSafe(environment, surfaceNonce, undefined, traceId);
          observeCapabilityRetirement(activeToken, externalProgress);
          const compiled = compileForCapacity(checkpointInput.parsed, activeToken, true);
          const resumeCompiled = resumeInput
            ? compileForCapacity(resumeInput, activeToken, true)
            : undefined;
          for (const candidate of [compiled, resumeCompiled]) {
            if (!candidate) continue;
            if (candidate.multipart) {
              throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
                status: 409,
                errorType: "invalid_request_error",
                code: "manual_multipart_unsupported",
                retryable: false,
              });
            }
          }
          tokenSettled = true;
          token.resolve(activeToken);
          if (!parsed._compactionRequest) {
            trace.push({
              kind: "commentary",
              text: "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the `Codex Zero Risk` plugin and the model you want, send the prompt, then confirm it was sent in the launcher.",
            });
          }
          await zeroRiskManualControl.start(retainedLauncherDescriptor, {
            ...owner,
            prompt: compiled.text,
            ...(resumeCompiled ? { resumePrompt: resumeCompiled.text } : {}),
            ...(conversationKey ? { conversationKey } : {}),
            ...(parsed._compactionRequest ? { compaction: true as const } : {}),
          });
          launcherStarted = true;
          await zeroRiskManualControl.waitSent(retainedLauncherDescriptor, owner, {
            abortSignal: browserAbort.signal,
          });
          await broker.confirmSafeTurnSent(activeToken, surfaceNonce);
          submission.phase = "accepted";
          if (!parsed._compactionRequest) trace.push({
            kind: "commentary",
            text: "> **Waiting for ChatGPT**\n>\n> The prompt is marked `Sent`. Waiting for `Codex Zero Risk` to bind this turn through the selected ChatGPT connector.",
          });
          const terminalAbort = new AbortController();
          const abortTerminal = () => terminalAbort.abort();
          browserAbort.signal.addEventListener("abort", abortTerminal, { once: true });
          const terminalFailure = zeroRiskManualControl.waitTerminal(
            retainedLauncherDescriptor,
            owner,
            { abortSignal: terminalAbort.signal },
          ).then(observed => Promise.reject(safeManualTerminalError(observed.status)))
            .catch(error => terminalAbort.signal.aborted
              ? new Promise<never>(() => {})
              : Promise.reject(error));
          let answer: string;
          try {
            await Promise.race([
              broker.waitForSafeStart(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
            await zeroRiskManualControl.markStarted(retainedLauncherDescriptor, owner);
            if (!parsed._compactionRequest) trace.push({
              kind: "commentary",
              text: "> **Zero Risk connected**\n>\n> `Codex Zero Risk` is connected. ChatGPT is now working through the native Codex harness; progress remains visible in the launcher.",
            });
            answer = await Promise.race([
              broker.waitForSafeCompletion(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
          } finally {
            terminalAbort.abort();
            browserAbort.signal.removeEventListener("abort", abortTerminal);
          }
          text.push(answer);
          try {
            await finishLauncher("completed");
          } catch (controlError) {
            // The broker result is already authoritative. A launcher acknowledgement failure may
            // leave UI cleanup pending, but it must not replace a completed Codex answer with an
            // error or trigger a contradictory failed terminal mutation.
            console.error(
              `[chatgpt-web] completed Zero Risk turn but could not confirm launcher cleanup: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          return answer;
        } catch (error) {
          const normalized = safeManualAdapterError(error);
          // Capture the causal state before our own cleanup revokes the broker capability. The
          // retirement observer also aborts browserAbort, but that self-induced abort must not turn
          // an ordinary launcher/runtime failure into a user cancellation.
          const externallyAborted = browserAbort.signal.aborted;
          if (activeToken) await Promise.resolve(broker.revoke(activeToken, normalized)).catch(() => {});
          try {
            await finishLauncher(externallyAborted ? "aborted" : "failed");
          } catch (controlError) {
            console.error(
              `[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          throw normalized;
        }
      };
      const browserTurn = cancellableBrowserTurn(trackBrowserOwner(runManual()), browserAbort);
      void browserTurn.browser.catch(error => {
        if (tokenSettled) return;
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      });
      return {
        mode: "tools",
        token: token.promise,
        externalProgress,
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        manualControl: { surfaceNonce },
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        retireCapability: async () => {
          if (activeToken) await broker.revoke(activeToken);
        },
        submission,
        cancel: (reason?: Error) => {
          browserTurn.cancel(reason);
          if (activeToken) {
            void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
              console.error(`[chatgpt-web] failed to revoke cancelled Zero Risk request: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      };
    }
    if (!mode.localTools) {
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileForCapacity(checkpointInput.parsed),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        ...compactionHeartbeatLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        submission,
        cancel: browserTurn.cancel,
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    const externalProgress = new ChatGptExternalTurnProgress();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const prepareWith = async (input: CodexParsedRequest) => {
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
      );
      activeToken = turnToken;
      try {
        const compiled = compileForCapacity(input, turnToken);
        // Publish only after preparation succeeds: otherwise its failure revokes the token
        // before the response observer uses it and masks the cause as an expired capability.
        observeCapabilityRetirement(turnToken, externalProgress);
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    // The retained-resume trim runs before the compiler is handed any messages, so a compiled
    // prompt cannot report what the request itself carried. Count that here, where the untrimmed
    // request is still in hand, and report the same number on both paths so the turn-open line
    // reads the same way whether or not the conversation was resumed.
    const requestImages = countChatGptContextImages(checkpointInput.parsed.context.messages);
    const prepareReporting = async (input: CodexParsedRequest) => ({
      ...(await prepareWith(input)),
      requestImages,
    });
    const browserTurn = cancellableBrowserTurn(trackBrowserOwner(finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      prepare: () => prepareReporting(checkpointInput.parsed),
      ...(resumeInput ? { prepareResume: () => prepareReporting(resumeInput) } : {}),
      ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      ...submissionLifecycle,
      ...multipartProgressLifecycle,
      ...compactionHeartbeatLifecycle,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => text.push(delta),
      externalProgress,
      completionFence: {
        begin: async () => broker.beginCompletionFence(await token.promise),
        commit: async revision => broker.commitCompletionFence(await token.promise, revision),
      },
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    }))), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      externalProgress,
      browser: browserTurn.browser,
      physicalSettlement: browserTurn.physicalSettlement,
      trace,
      text,
      usageInput: checkpointInput.parsed,
      ...(conversationKey ? { conversationKey } : {}),
      ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
      retireCapability: async () => {
        if (activeToken) await broker.revoke(activeToken);
      },
      submission,
      cancel: (reason?: Error) => {
        browserTurn.cancel(reason);
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  const startImageContinuationRuntime = (
    parsed: CodexParsedRequest,
    environment: NonNullable<ReturnType<typeof extractChatGptTurnEnvironment>>,
    session: ChatGptTurnSession,
    turnCapabilities: ChatGptWebCapabilities,
    phase: number,
    images: ChatGptWebPromptImage[],
  ): { runtime: ChatGptTurnRuntime; traceId: string } => {
    const conversationKey = session.conversationKey();
    if (!conversationKey) throw new Error("retained ChatGPT conversation is unavailable for image continuation");
    const parentTrace = session.traceId ?? chatGptWebTraceId(provider, parsed);
    const continuationTraceId = imageContinuationTraceId(parentTrace, phase);
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const externalProgress = new ChatGptExternalTurnProgress();
    const token = deferred<string>();
    const phaseAbort = new AbortController();
    const sessionSignal = session.abortSignal();
    const abortFromSession = () => phaseAbort.abort(sessionSignal.reason);
    if (sessionSignal.aborted) abortFromSession();
    else sessionSignal.addEventListener("abort", abortFromSession, { once: true });
    let tokenSettled = false;
    let activeToken: string | undefined;
    let browserOwnerSettled = false;
    const prepareContinuation = async () => {
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        continuationTraceId,
      );
      activeToken = turnToken;
      if (!tokenSettled) {
        tokenSettled = true;
        token.resolve(turnToken);
        const tokenHash = createHash("sha256").update(turnToken).digest("hex").slice(0, 12);
        console.info(
          `[chatgpt-web] image continuation token phase=${phase} length=${turnToken.length} sha256=${tokenHash}`,
        );
        void broker.waitForRetirement(turnToken).then(
          () => {
            if (browserOwnerSettled || phaseAbort.signal.aborted) return;
            const retirement = new Error("Codex Native retired the image continuation binding before its tool work completed");
            externalProgress.retire(retirement);
            phaseAbort.abort(retirement);
          },
          error => {
            if (browserOwnerSettled || phaseAbort.signal.aborted) return;
            const failure = new Error("ChatGPT could not observe image continuation retirement", { cause: error });
            externalProgress.retire(failure);
            phaseAbort.abort(failure);
          },
        );
      }
      return {
        text: `${DELIVERED_IMAGES_PROMPT}\n\n${chatGptTurnTokenInstruction(turnToken)}`,
        images,
        release: () => {},
        requestImages: images.length,
      };
    };
    const browserRun = worker.run({
      traceId: continuationTraceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: { ...turnCapabilities, localToolsEnabled: true },
      nativeConnector: true,
      streamsToCodex: true,
      prepare: prepareContinuation,
      prepareResume: prepareContinuation,
      retainConversation: true,
      conversationKey,
      requireRetainedConversation: true,
      abortSignal: phaseAbort.signal,
      onReasoningSummary: (value, continuation) => trace.push({
        kind: "reasoning",
        text: value,
        ...(continuation ? { continuation: true } : {}),
      }),
      onCommentary: (value, continuation) => trace.push({
        kind: "commentary",
        text: value,
        ...(continuation ? { continuation: true } : {}),
      }),
      onTextDelta: delta => text.push(delta),
      externalProgress,
      completionFence: {
        begin: async () => broker.beginCompletionFence(await token.promise),
        commit: async revision => broker.commitCompletionFence(await token.promise, revision),
      },
    }).finally(() => {
      browserOwnerSettled = true;
      sessionSignal.removeEventListener("abort", abortFromSession);
    });
    const browserTurn = cancellableBrowserTurn(browserRun, phaseAbort);
    void browserTurn.browser.catch(error => {
      if (tokenSettled) return;
      tokenSettled = true;
      token.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return {
      traceId: continuationTraceId,
      runtime: {
        mode: "tools",
        token: token.promise,
        externalProgress,
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: parsed,
        conversationKey,
        ...(session.runtime.releaseRetainedConversation
          ? { releaseRetainedConversation: session.runtime.releaseRetainedConversation }
          : {}),
        retireCapability: async () => {
          if (activeToken) await broker.revoke(activeToken);
        },
        cancel: (reason?: Error) => {
          browserTurn.cancel(reason);
          if (activeToken) {
            void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
              console.error(`[chatgpt-web] failed to revoke cancelled image continuation token: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const runChatGptWebTurn = async (): Promise<void> => {
        const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
        if (manualRequest !== manualInteraction) {
          emit({
            type: "error",
            message: manualInteraction
              ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
              : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
            status: 409,
            errorType: "invalid_request_error",
            code: "browser_interaction_mode_mismatch",
            retryable: false,
          });
          return;
        }
        const turnCapabilities = parsed._compactionRequest && !manualRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = manualRequest
          ? { localTools: true }
          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
        if (mode.localTools) {
          try {
            environment = environmentStore.resolve(parsed);
            backfillEmptyToolSearchResults(parsed, environment.tools);
          } catch (error) {
            const identity = extractChatGptTurnIdentity(parsed);
            console.warn(
              `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
            );
            throw error;
          }
        }
        if (parsed._compactionRequest) {
          const structuredCompactionRequired = parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
            && configuredCapabilities.localToolsEnabled;
          if (structuredCompactionRequired
            && (!retainedLauncherDescriptor || (!manualRequest && !structuredBroker))) {
            emit({
              type: "error",
              message: manualRequest
                ? "Zero Risk could not resume the active ChatGPT conversation for context handoff. Retry the task from the Launcher."
                : "ChatGPT could not resume the active conversation for context handoff. Retry the task.",
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_control_unavailable",
              retryable: false,
            });
            return;
          }
          if (structuredCompactionRequired) {
            const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
            const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
            const handoffTraceId = createHash("sha256")
              .update(`${compactionExecutionKey}:handoff`)
              .digest("hex")
              .slice(0, 12);
            const compactionTraceId = createHash("sha256")
              .update(compactionExecutionKey)
              .digest("hex")
              .slice(0, 12);
            const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
            let sharedSummary = existingStructuredCompactionRun(compactionExecutionKey);
            if (!sharedSummary) {
              sharedSummary = runStructuredCompactionOnce(
                compactionExecutionKey,
                {
                  ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                  traceIds: [
                    compactionTraceId,
                    handoffTraceId,
                    `${handoffTraceId}_fallback`,
                  ],
                  ...(compactionNativeIdentity.threadId
                    ? { nativeThreadId: compactionNativeIdentity.threadId }
                    : {}),
                  ...(compactionNativeIdentity.turnId
                    ? { nativeTurnId: compactionNativeIdentity.turnId }
                    : {}),
                },
                async (operatorSignal, retainOwnershipUntil) => {
                  const handoffTimeoutMs = Math.min(
                    timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                    MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                  );
                  const handoffDeadline = new AbortController();
                  const handoffTimeoutError = new ChatGptWebAdapterError(
                    `ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`,
                    {
                      status: 409,
                      errorType: "invalid_request_error",
                      code: "compaction_handoff_timeout",
                      retryable: false,
                    },
                  );
                  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
                  const armHandoffDeadline = (): void => {
                    if (handoffDeadline.signal.aborted) return;
                    if (handoffTimer) clearTimeout(handoffTimer);
                    handoffTimer = setTimeout(
                      () => handoffDeadline.abort(handoffTimeoutError),
                      handoffTimeoutMs,
                    );
                    handoffTimer.unref?.();
                  };
                  armHandoffDeadline();
                  const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
                  const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
                  const runFreshCompactionFallback = async (reason: string): Promise<string> => {
                    console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
                    // The fallback is a new bounded phase. Each exact multipart acknowledgement
                    // and the final accepted compact prompt re-arms the five-minute liveness budget;
                    // transport time cannot consume the model-generation window.
                    armHandoffDeadline();
                    const reportCompactionProgress = (
                      kind: "submitted" | "multipart" | "heartbeat",
                    ): void => {
                      armHandoffDeadline();
                      if (kind !== "heartbeat") return;
                      emit({ type: "heartbeat" });
                      emit({
                        type: "text_delta",
                        text: "Context compaction is still running in ChatGPT…",
                        phase: "commentary",
                      });
                    };
                    const fallbackRuntime = startRuntime(
                      parsed,
                      manualRequest ? environment : undefined,
                      `${handoffTraceId}_fallback`,
                      turnCapabilities,
                      { onCompactionProgress: reportCompactionProgress },
                    );
                    retainOwnershipUntil(fallbackRuntime.physicalSettlement);
                    try {
                      const rawSummary = await withAbort(fallbackRuntime.browser, operationSignal);
                      await withAbort(fallbackRuntime.physicalSettlement, operationSignal);
                      return canonicalizeCompactionHandoff(parsed, rawSummary);
                    } catch (error) {
                      fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                      // The shared owner retains physical settlement independently of this error.
                      // Neither a timeout nor operator cancellation can open a competing trace.
                      throw error;
                    }
                  };
                  let source: ChatGptTurnSession | undefined;
                  let preserveFinalResponse = false;
                  let interruptedWork: CompactionPendingToolRequest[] = [];
                  try {
                    // The previous compaction may already have detached the retained head while
                    // its browser/helper is still unwinding. Do not inspect that old epoch or
                    // decide to open a fresh fallback until physical release has completed.
                    if (sourceConversationKey) {
                      await chatGptTurnSessions.waitForConversationRetirement(
                        sourceConversationKey,
                        operationSignal,
                      );
                    }
                    source = sourceConversationKey
                      ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
                      : undefined;
                    preserveFinalResponse = !source?.isActive()
                      && source?.settledOutcome()?.type === "final";
                    const retainedKey = source?.conversationKey();
                    if (!source || !retainedKey) {
                      return await runFreshCompactionFallback("source_unavailable_before_handoff");
                    }
                    let rawSummary: string;
                    if (manualRequest && source.isActive() && source.runtime.mode === "tools") {
                      const zeroRiskSummary = await settleActiveZeroRiskCompactionSource(
                        parsed,
                        source,
                        broker,
                        operationSignal,
                      );
                      if (zeroRiskSummary === undefined) {
                        preserveFinalResponse = true;
                        rawSummary = await runFreshCompactionFallback("zero_risk_source_had_no_compaction_boundary");
                      } else {
                        rawSummary = zeroRiskSummary;
                      }
                    } else if (manualRequest) {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await runFreshCompactionFallback("zero_risk_source_already_completed");
                    } else if (source.isActive() && source.runtime.mode === "tools") {
                      const settlement = await settleActiveCompactionSource(
                        parsed,
                        source,
                        structuredBroker!,
                        operationSignal,
                      );
                      preserveFinalResponse = !settlement.compactionInstructionDelivered;
                      interruptedWork = settlement.interruptedWork ?? [];
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    } else {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    }
                    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
                    await withAbort(
                      preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                      operationSignal,
                    );
                    if (!manualRequest) {
                      stageCompactionContinuationPendingWork(parsed, compactionNativeIdentity, interruptedWork);
                    }
                    return summary;
                  } catch (error) {
                    const retainedKey = source?.conversationKey();
                    if (!retainedKey) throw error;
                    let handoffError = error instanceof Error ? error : new Error(String(error));
                    try {
                      // Operator cancellation ends the logical compaction, but cancel-all must not
                      // acknowledge until the retained browser/helper owner has physically retired.
                      await (preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source!,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey));
                    } catch (retirementError) {
                      handoffError = new AggregateError(
                        [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                        "Structured compaction failed and its retained conversation could not be retired",
                      );
                    }
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_source_unavailable") {
                      return await runFreshCompactionFallback("source_disappeared_before_handoff");
                    }
                    throw handoffError;
                  } finally {
                    if (handoffTimer) clearTimeout(handoffTimer);
                  }
                },
              );
            }
            emit({ type: "heartbeat" });
            let summary: string;
            try {
              summary = await withAbort(sharedSummary, incoming.abortSignal);
            } catch (error) {
              if (incoming.abortSignal?.aborted
                && error instanceof DOMException
                && error.name === "AbortError") {
                // The observer detached; the shared exact compaction round continues and remains
                // available to a canonical reconnect without a second browser submission.
                throw error;
              }
              const handoffError = error instanceof Error ? error : new Error(String(error));
              console.error("[chatgpt-web] structured context handoff failed:", handoffError);
              // Nine distinct failures reach this catch - a five-minute settle timeout, an empty
              // handoff, a missing or conflicting latest-user marker, a missing MCP tool boundary,
              // missing native ids - and collapsing them into one sentence told the user to retry
              // even for the ones that can only ever fail the same way again.
              //
              // An error that already classified itself knows better than this site can: its
              // message, code and retry posture pass through untouched.
              if (handoffError instanceof ChatGptWebAdapterError) {
                emit({
                  type: "error",
                  message: handoffError.message,
                  status: handoffError.status,
                  errorType: handoffError.errorType,
                  code: handoffError.code,
                  retryable: handoffError.retryable,
                });
                return;
              }
              emit({
                type: "error",
                message: `ChatGPT did not complete the context handoff: ${handoffError.message}`,
                status: 409,
                errorType: "invalid_request_error",
                code: "compaction_handoff_failed",
                retryable: false,
              });
              return;
            }
            emit({ type: "text_delta", text: summary, phase: "final_answer" });
            emitBrowserCompletion(
              { type: "final", answer: summary },
              estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
              emit,
            );
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }
          const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
          await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
        }
        const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const ownerKey = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const nativeTurnId = nativeIdentity.turnId;
        if (!nativeTurnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser ownership");
        const abortedTurnIds = manualRequest ? new Set(priorChatGptAbortedTurnIds(parsed)) : undefined;
        if (abortedTurnIds?.size) {
          chatGptTurnSessions.retireAbortedOwnerTurns(ownerKey, abortedTurnIds, executionKey);
        }
        const traceId = chatGptWebTraceId(provider, parsed);
        const session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
          executionKey,
          ownerKey,
          () => startRuntime(parsed, environment, traceId, turnCapabilities),
          traceId,
          incoming.abortSignal,
          nativeTurnId,
          nativeIdentity.threadId,
          chatGptInstructionLineage(parsed),
        );
        let windowRecovery = windowRecoveryBySession.get(session);
        if (!windowRecovery) {
          windowRecovery = new WindowRecoveryTracker();
          windowRecoveryBySession.set(session, windowRecovery);
        }
        const roundKey = chatGptTurnRoundKey(parsed);
        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {
          // Journal the complete synchronous event batch before touching the HTTP observer. If the
          // observer disconnects midway through emission, an exact reconnect can replay the entire
          // canonical batch instead of losing the already-drained tail.
          session.appendRoundEvents(roundKey, events);
          for (const event of events) emit(event);
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events);
        };
        const emitRoundEvent = (event: AdapterEvent): void => emitRoundEvents([event]);
        try {
          await session.runExclusive(async () => {
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            const settledNeedsImageContinuation = settled !== undefined
              && (session.phaseNumber() > 0 || (unshownImagesBySession.get(session) ?? []).length > 0);
            if (settled && !settledNeedsImageContinuation) {
              if (settled.type === "error") throw settled.error;
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drain();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                if (replay.length === 0 && !parsed._compactionRequest) {
                  emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
                }
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
                if (!bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas(completedTextDeltas, buffer));
                }
              }
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
              }
              const unshownImageNotice = sessionUnshownImageNotice(session);
              if (unshownImageNotice && !bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([unshownImageNotice], buffer));
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                buffer,
              ));
              session.completeRound(roundKey);
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            let turnToken: string | undefined;
            if (session.runtime.mode === "tools") {
              turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
              await broker.updateEnvironment(turnToken, environment);

              const outstanding = session.outstanding();
              if (outstanding.length > 0) {
                const results = currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                    buffer,
                  ));
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                const callsById = new Map(outstanding.map(request => [request.callId, request]));
                const batchHasPolicyStop = results.some(message => (
                  callObservesWindow(callsById.get(message.toolCallId))
                  && isPolicyStop(toolResultText(message.content))
                ));
                if (batchHasPolicyStop && windowRecovery.standDown()?.kind === "stand_down") {
                  console.warn(`[chatgpt-web] Computer Use policy stop, window recovery stands down`);
                }
                for (const message of results) {
                  // A minimized window answers with guidance rather than an error, so this reads the
                  // result the call actually returned. It never touches isError.
                  const recovery = batchHasPolicyStop
                    ? undefined
                    : windowRecovery.inspect(callsById.get(message.toolCallId), message);
                  if (recovery?.kind === "recover") {
                    console.warn(
                      `[chatgpt-web] window observation needs recovery, sending the step back`
                      + ` target=${recovery.target ?? "unbound"}`,
                    );
                  } else if (recovery?.kind === "succeeded") {
                    console.warn(`[chatgpt-web] window recovery returned an image target=${recovery.target}`);
                  } else if (recovery?.kind === "near_miss") {
                    // Canary: the guidance wording lives in the @oai/sky runtime and cannot be
                    // checked against the installed plugin, so a reworded release must be visible.
                    const signature = createHash("sha256").update(recovery.text).digest("hex").slice(0, 12);
                    console.warn(
                      `[chatgpt-web] window observation matched no known guidance`
                      + ` chars=${recovery.text.length} sha256=${signature}`,
                    );
                  }
                  await broker.completeTool(
                    turnToken,
                    message.toolCallId,
                    brokerResult(message, recovery?.kind === "recover" ? recovery.note : undefined),
                  );
                  const undeliveredImages = toolImagesNeedingDelivery(message.content);
                  if (undeliveredImages.length > 0) {
                    // Kept for the delivery turn below. The cap is ChatGPT's own attachment limit,
                    // and the newest images are the ones the answer is about, so a long tool round
                    // drops its oldest rather than refusing to attach anything.
                    unshownImagesBySession.set(session, newestToolImages([
                      ...(unshownImagesBySession.get(session) ?? []),
                      ...undeliveredImages,
                    ]));
                    console.warn(`[chatgpt-web] broker image result cannot be attached to active browser turn trace=${session.traceId}`);
                  } else if (toolResultHasImage(message.content)) {
                    console.info(`[chatgpt-web] broker image result delivered inline trace=${session.traceId}`);
                  }
                  session.runtime.externalProgress.recordToolResult();
                  session.markResultDelivered(message.toolCallId);
                }
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              const emitNewText = (deltas: string[]) => {
                if (bufferStructuredOutput) return;
                const separated = separatePhaseText(
                  deltas,
                  session.phaseNumber(),
                  separatedPhaseBySession.get(session),
                  lastCompletedAnswerBySession.get(session),
                );
                if (separated.separatedPhase !== undefined) separatedPhaseBySession.set(session, separated.separatedPhase);
                emitRoundBatch(buffer => emitTextDeltas(separated.deltas, buffer));
              };
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              const externalProgress = session.runtime.mode === "tools"
                ? session.runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    const revision = externalProgress.recordToolBatch(requests.length);
                    if (!session.runtime.manualControl) {
                      // The browser outcome is in the same race below and owns the semantic DOM and
                      // renderer deadlines. A second fixed timer here can retire an accepted turn
                      // while its same-tab observer is still recovering. Keep the causal barrier —
                      // tools are not emitted until the browser captures their text boundary — but
                      // let browser settlement or request cancellation end the wait.
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        toolWaitAbort.signal,
                      );
                    }
                    externalProgress.assertToolBatchActive(revision);
                  }
                  return { type: "tools" as const, requests };
                }).catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error))
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              let runImageContinuationBoundary: (() => Promise<void>) | undefined;
              const finishBrowserOutcome = async (
                observedOutcome: ChatGptBrowserOutcome,
                activeRuntime: ChatGptTurnRuntime = session.runtime,
                activeToken: string | undefined = turnToken,
              ): Promise<void> => {
                // Zero Risk completion and its owner-only empty-batch signal are resolved by the
                // same broker transition. Drain once more so the accepted final answer cannot be
                // overtaken by the terminal owner notification.
                emitNewTrace(activeRuntime.trace.drain());
                emitNewText(activeRuntime.text.drain());
                session.setFinalReasoning(roundReasoning);
                const phase = session.phaseNumber();
                const attachedPhaseImages = activeContinuationImagesBySession.get(session) ?? [];
                let completedOutcome = observedOutcome;
                if (activeToken) await broker.revoke(activeToken);
                if (completedOutcome.type === "error") {
                  if (phase === 0) throw completedOutcome.error;
                  const reason = completedOutcome.error.message;
                  console.warn(
                    `[chatgpt-web] image continuation phase=${phase} images=${attachedPhaseImages.length}`
                    + ` trace=${imageContinuationTraceId(session.traceId ?? traceId, phase)}`
                    + ` failed reason=${JSON.stringify(reason)}`,
                  );
                  const pending = newestToolImages([...attachedPhaseImages, ...(unshownImagesBySession.get(session) ?? [])]);
                  activeContinuationImagesBySession.delete(session);
                  if (pending.length > 0) unshownImagesBySession.set(session, pending);
                  const limitError = completedOutcome.error;
                  if (limitError instanceof ChatGptWebAdapterError && limitError.code === "chatgpt_attachment_limit") {
                    attachmentLimitBySession.set(session, limitError.message.match(/\("([^"]*)"\)/)?.[1] ?? "");
                  }
                  const lastAnswer = lastCompletedAnswerBySession.get(session);
                  if (lastAnswer === undefined) throw completedOutcome.error;
                  completedOutcome = { type: "final", answer: lastAnswer };
                }
                if (completedOutcome.type !== "final") throw new Error("ChatGPT browser outcome was not finalized");
                if (observedOutcome.type === "final" && activeRuntime.text.value() !== observedOutcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                if (observedOutcome.type === "final") {
                  lastCompletedAnswerBySession.set(session, observedOutcome.answer);
                  if (phase > 0) {
                    console.warn(
                      `[chatgpt-web] image continuation phase=${phase} images=${attachedPhaseImages.length}`
                      + ` trace=${imageContinuationTraceId(session.traceId ?? traceId, phase)} completed`,
                    );
                    const attachedIn = session.conversationKey();
                    if (attachedIn) recordAttachedToolImages(attachedIn, attachedPhaseImages);
                    activeContinuationImagesBySession.delete(session);
                  }
                }
                if (phase === 0) structuredOutputValidator?.(completedOutcome.answer);
                if (phase === 0 && bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas([completedOutcome.answer], buffer));
                }
                const pendingImages = unshownImagesBySession.get(session) ?? [];
                const continuationEnvironment = environment;
                const continuationEligible = observedOutcome.type === "final"
                  && !bufferStructuredOutput
                  && pendingImages.length > 0
                  && continuationEnvironment !== undefined
                  && session.conversationKey() !== undefined
                  && activeRuntime.mode === "tools"
                  && phase < MAX_IMAGE_CONTINUATION_PHASES
                  && !attachmentLimitBySession.has(session);
                if (continuationEligible) {
                  const nextPhase = phase + 1;
                  const continuationImages = [...pendingImages];
                  unshownImagesBySession.delete(session);
                  try {
                    const continuation = startImageContinuationRuntime(
                      parsed,
                      continuationEnvironment!,
                      session,
                      turnCapabilities,
                      nextPhase,
                      continuationImages,
                    );
                    activeContinuationImagesBySession.set(session, continuationImages);
                    session.activateRuntime(continuation.runtime, nextPhase);
                    console.warn(
                      `[chatgpt-web] image continuation phase=${nextPhase} images=${continuationImages.length}`
                      + ` trace=${continuation.traceId} started`,
                    );
                    if (!runImageContinuationBoundary) {
                      throw new Error("image continuation boundary runner was not initialized");
                    }
                    await runImageContinuationBoundary();
                    return;
                  } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    activeContinuationImagesBySession.delete(session);
                    unshownImagesBySession.set(session, newestToolImages(continuationImages));
                    console.warn(
                      `[chatgpt-web] image continuation phase=${nextPhase} images=${continuationImages.length}`
                      + ` trace=${imageContinuationTraceId(session.traceId ?? traceId, nextPhase)}`
                      + ` failed reason=${JSON.stringify(reason)}`,
                    );
                  }
                }
                let delivered: string | undefined;
                let deliveredImageFallback = false;
                if (completedOutcome.type === "final"
                  && !bufferStructuredOutput
                  && pendingImages.length > 0
                  && session.conversationKey() !== undefined
                  && !imagesDeliveredSessions.has(session)
                  && !attachmentLimitBySession.has(session)) {
                  // The one path that gets a tool's image in front of the model: attachments are
                  // uploaded while a turn is being composed, so an image that arrived mid-generation
                  // needs a turn of its own. Once per session — a delivery turn per screenshot in a
                  // long round would cost more browser turns than the work itself.
                  imagesDeliveredSessions.add(session);
                  const prepareDelivery = async () => ({
                    text: DELIVERED_IMAGES_PROMPT,
                    images: pendingImages,
                    release: () => {},
                  });
                  let deliveryFailure: string | undefined;
                  try {
                    delivered = await worker.run({
                      traceId,
                      modelId: parsed.modelId,
                      reasoning: parsed.options.reasoning,
                      // Tool-less on purpose: looking at an attachment needs no tools, so this turn
                      // carries no token and cannot hit the retired-channel problem. Whether the model wants to carry
                      // the work on once it can finally see the image is a question about a model, so
                      // the log below counts it rather than the code assuming it.
                      capabilities: { ...turnCapabilities, localToolsEnabled: false },
                      nativeConnector: false,
                      // This answer is appended, not streamed, so a late ChatGPT edit is harmless.
                      streamsToCodex: false,
                      prepare: prepareDelivery,
                      prepareResume: prepareDelivery,
                      conversationKey: session.conversationKey(),
                      requireRetainedConversation: true,
                      abortSignal: session.abortSignal(),
                      onTextDelta: () => {},
                    });
                  } catch (error) {
                    // Best effort: a failed delivery falls back to the notice below, which is what
                    // this turn would have said anyway.
                    deliveryFailure = error instanceof Error ? error.message : String(error);
                  }
                  console.warn(
                    `[chatgpt-web] tool image delivery turn images=${pendingImages.length}`
                    + ` answered=${delivered !== undefined}`
                    + (deliveryFailure !== undefined ? ` failure=${JSON.stringify(deliveryFailure)}` : ""),
                  );
                  if (delivered !== undefined && delivered.trim().length > 0) {
                    deliveredImageFallback = true;
                    unshownImagesBySession.delete(session);
                    emitRoundBatch(buffer => emitTextDeltas([`\n\n${delivered}`], buffer));
                  }
                }
                if (phase > 0 && observedOutcome.type === "final" && pendingImages.length === 0) {
                  console.warn(`[chatgpt-web] image continuation chain phases=${phase} final=without_images`);
                } else if (phase > 0 && observedOutcome.type === "error") {
                  console.warn(`[chatgpt-web] image continuation chain phases=${phase} final=fallback`);
                } else if (pendingImages.length > 0 && !continuationEligible) {
                  console.warn(
                    `[chatgpt-web] image continuation chain phases=${phase}`
                    + ` final=${phase >= MAX_IMAGE_CONTINUATION_PHASES
                      ? "limit"
                      : deliveredImageFallback
                        ? "with_images"
                        : "fallback"}`,
                  );
                }
                // Only for images still unshown: a delivered one is no longer unseen, and saying it
                // was would contradict the answer just appended.
                const unshownImageNotice = sessionUnshownImageNotice(session);
                if (unshownImageNotice && !bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas([unshownImageNotice], buffer));
                }
                session.setFinalEvents(session.roundEvents(roundKey));
                emitRoundBatch(buffer => emitBrowserCompletion(
                  completedOutcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                chatGptWebTurnRetryPolicy.clear(retryKey);
              };
              runImageContinuationBoundary = async () => {
                const continuationRuntime = session.runtime;
                if (continuationRuntime.mode !== "tools") {
                  throw new Error("Image continuation requires a tool-capable ChatGPT runtime");
                }
                if (!environment) {
                  throw new Error("Image continuation lost its trusted Codex environment");
                }
                const continuationToken = await withAbort(continuationRuntime.token, incoming.abortSignal);
                await broker.updateEnvironment(continuationToken, environment);
                const continuationWaitAbort = new AbortController();
                try {
                  const continuationProgress = continuationRuntime.externalProgress;
                  const nextContinuationTools = broker.nextToolBatch(
                    continuationToken,
                    continuationWaitAbort.signal,
                  ).then(async requests => {
                    if (requests.length > 0) {
                      const revision = continuationProgress.recordToolBatch(requests.length);
                      await continuationProgress.waitForToolBatchObservation(
                        revision,
                        continuationWaitAbort.signal,
                      );
                      continuationProgress.assertToolBatchActive(revision);
                    }
                    return { type: "tools" as const, requests };
                  }).catch(error => continuationWaitAbort.signal.aborted
                    ? new Promise<never>(() => {})
                    : Promise.reject(error));
                  const continuationBrowser = session.browserOutcome.then(outcome => ({
                    type: "browser" as const,
                    outcome,
                  }));
                  const waitForContinuationTrace = () => continuationRuntime.trace.wait(continuationWaitAbort.signal)
                    .then(() => ({ type: "trace" as const }))
                    .catch(error => continuationWaitAbort.signal.aborted
                      ? new Promise<never>(() => {})
                      : Promise.reject(error));
                  const waitForContinuationText = () => continuationRuntime.text.wait(continuationWaitAbort.signal)
                    .then(() => ({ type: "text" as const }))
                    .catch(error => continuationWaitAbort.signal.aborted
                      ? new Promise<never>(() => {})
                      : Promise.reject(error));
                  let nextTrace = waitForContinuationTrace();
                  let nextText = waitForContinuationText();
                  for (;;) {
                    const next = await withAbort(Promise.race([
                      nextContinuationTools,
                      continuationBrowser,
                      nextTrace,
                      nextText,
                    ]), incoming.abortSignal);
                    if (next.type === "trace") {
                      emitNewTrace(continuationRuntime.trace.drain());
                      nextTrace = waitForContinuationTrace();
                      continue;
                    }
                    if (next.type === "text") {
                      emitNewText(continuationRuntime.text.drain());
                      nextText = waitForContinuationText();
                      continue;
                    }
                    emitNewTrace(continuationRuntime.trace.drain());
                    emitNewText(continuationRuntime.text.drain());
                    if (next.type === "browser") {
                      await finishBrowserOutcome(next.outcome, continuationRuntime, continuationToken);
                      return;
                    }
                    if (next.requests.length === 0) {
                      throw new Error("ChatGPT image continuation returned an empty tool batch");
                    }
                    validateBatchTools(parsed, next.requests);
                    session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                    emitRoundBatch(buffer => emitToolBatch(
                      next.requests,
                      estimateChatGptWebUsage(
                        currentUsageInput(parsed),
                        { reasoning: roundReasoning, toolRequests: next.requests },
                        turnCapabilities,
                        experimentalBiggerContext,
                        experimentalSkillAttachments,
                      ),
                      buffer,
                    ));
                    session.completeRound(roundKey);
                    return;
                  }
                } finally {
                  continuationWaitAbort.abort();
                }
              };
              const waitForTrace = () => session.runtime.trace.wait(toolWaitAbort.signal)
                .then(() => ({ type: "trace" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              const waitForText = () => session.runtime.text.wait(toolWaitAbort.signal)
                .then(() => ({ type: "text" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              let nextTrace = waitForTrace();
              let nextText = waitForText();
              for (;;) {
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    nextTrace,
                    nextText,
                  ]),
                  incoming.abortSignal,
                );
                if (next.type === "trace") {
                  emitNewTrace(session.runtime.trace.drain());
                  nextTrace = waitForTrace();
                  continue;
                }
                if (next.type === "text") {
                  emitNewText(session.runtime.text.drain());
                  nextText = waitForText();
                  continue;
                }
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                if (next.type === "browser") {
                  await finishBrowserOutcome(next.outcome);
                  return;
                }
                if (!turnToken || session.runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) {
                  if (!session.runtime.manualControl) {
                    throw new Error("ChatGPT tool bridge returned an empty batch");
                  }
                  await finishBrowserOutcome(await session.browserOutcome);
                  return;
                }
                validateBatchTools(parsed, next.requests);
                session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
          });
        } catch (error) {
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            if (session.runtime.manualControl) {
              // Zero Risk is user-driven and has no DOM observer that can distinguish continued
              // work from a stopped native turn. A closed Responses stream is therefore terminal:
              // revoke the MCP capability and release the Launcher tab instead of leaving a task
              // that Codex already shows as stopped waiting forever.
              chatGptTurnSessions.retire(executionKey, session);
            }
            // Automatic browser turns keep their exact execution and journal for reconnect. Their
            // owned DOM observer can continue proving the same accepted ChatGPT submission.
            throw error;
          }
          const turnError = submittedTurnFailure(session, error);
          const handledError = turnError instanceof ChatGptWebAdapterError && turnError.retryable
            ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError)
            : turnError;
          if (!(turnError instanceof ChatGptWebAdapterError && turnError.retryable)) {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
            // A deterministic request failure remains replayable so a native reconnect cannot burn
            // another browser attempt. Every other failure retires the browser session: client
            // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
            // instead of replaying one rejected browser outcome for the registry's full TTL.
            session.cancel();
          } else {
            chatGptTurnSessions.retire(executionKey, session);
          }
          if (session.runtime.mode === "tools") {
            void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
          }
          if (handledError instanceof ChatGptWebAdapterError) {
            emitRoundEvent({
              type: "error",
              message: handledError.message,
              status: handledError.status,
              errorType: handledError.errorType,
              code: handledError.code,
              retryable: handledError.retryable,
            });
            session.completeRound(roundKey);
            return;
          }
          session.failRound(roundKey, turnError);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        }
      };

      // Arm this before any awaited work, including environment lookup and owner retirement.
      const heartbeat = setInterval(
        () => emit({ type: "heartbeat" }),
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      try {
        emit({ type: "heartbeat" });
        await runChatGptWebTurn();
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
