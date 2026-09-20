import { createHash } from "node:crypto";
import { SUMMARY_PREFIX, isOnePixelPngDataUrl } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_MAX_INPUT_IMAGES } from "./prompt";

function messageText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

/** Native compaction remains part of the exact identity of a replayed Codex turn. */
function compactionEpoch(input: unknown[] | undefined): unknown {
  return input?.findLast(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.type === "compaction"
      || record.type === "compaction_summary"
      || record.type === "context_compaction"
      || (record.role === "user" && messageText(record)?.startsWith(`${SUMMARY_PREFIX}\n`));
  }) ?? null;
}

export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    compaction: compactionEpoch(raw?.input),
  })).digest("hex");
}

/** A retained epoch receives the suffix after its last assistant reply.
 * Tool-returned images from the immediately preceding round were delivered to the browser as
 * MCP results, not as browser image attachments. Carry those images into the next native turn's
 * existing attachment path, once, without replaying the previous round's text or older images.
 */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest | undefined {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  if (lastAssistant < 0 || lastAssistant === parsed.context.messages.length - 1) return undefined;
  const suffix = parsed.context.messages.slice(lastAssistant + 1);
  // Assistant tool-call holders are also messages, so an assistant boundary could cut off
  // earlier tool results from the same native user turn. Use its preceding user request.
  const precedingUser = parsed.context.messages.slice(0, lastAssistant)
    .findLastIndex(message => message.role === "user");
  const seen = new Set<string>();
  for (const message of suffix) {
    if (message.role === "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image") seen.add(part.imageUrl);
    }
  }
  const imageResults: typeof suffix = [];
  let images = 0;
  for (let i = lastAssistant - 1; i > precedingUser && images < CHATGPT_MAX_INPUT_IMAGES; i -= 1) {
    const message = parsed.context.messages[i]!;
    if (message.role !== "toolResult" || typeof message.content === "string") continue;
    const distinctImages = message.content.filter(part => {
      if (part.type !== "image" || isOnePixelPngDataUrl(part.imageUrl)
        || seen.has(part.imageUrl) || images >= CHATGPT_MAX_INPUT_IMAGES) return false;
      seen.add(part.imageUrl);
      images += 1;
      return true;
    });
    if (distinctImages.length > 0) imageResults.unshift({ ...message, content: distinctImages });
  }
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: [...imageResults, ...suffix],
    },
  };
}
