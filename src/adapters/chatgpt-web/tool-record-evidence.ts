import type { Page } from "playwright-core";

/**
 * What ChatGPT's own record of the conversation says about this turn's tool calls.
 *
 * On 28 Sep at 17:48 UTC a capability test ended "the click was blocked by ChatGPT's safety layer"
 * and quoted "Bu araç çağrısı, isteğin güvenlik durumunu belirleyemediğimiz için OpenAI tarafından
 * engellendi." The bridge took the quote as ChatGPT's own refusal (v5.0.40) and skipped its
 * correction. ChatGPT's record of that conversation said otherwise: the click call had nothing under
 * it at all — no result, no error, no refusal — the model's next thought was that it had done the
 * multiplication, and the quoted sentence appeared in one of 130 messages, the model's own answer.
 * The call never reached the bridge either. A quote is not evidence; the record is.
 */
export interface ChatGptToolRecordEvidence {
  /** Tool calls of this turn with nothing under them in the record: not run, no error, no refusal. */
  unansweredCalls: number;
  /** A tool or system message of this turn carries a refusal, so a block claim may be quoting it. */
  platformRefusal: boolean;
}

interface RecordNode {
  parent: string | null;
  children: string[];
  role: string | null;
  recipient: string | null;
  text: string;
}

// Refusal wordings only. A tool's own output may say "blocked" or "denied" for its own reasons;
// those are results, not ChatGPT refusing to run the call.
const PLATFORM_REFUSAL = /g[üu]venlik durumunu belirleyemedi|OpenAI taraf[ıi]ndan engellendi|g[üu]venlik kontrolleri taraf[ıi]ndan engellendi|blocked by OpenAI|could not determine the safety/i;

export function parseChatGptToolRecordEvidence(value: unknown): ChatGptToolRecordEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { unansweredCalls, platformRefusal } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(unansweredCalls) || (unansweredCalls as number) < 0) return undefined;
  if (typeof platformRefusal !== "boolean") return undefined;
  return { unansweredCalls: unansweredCalls as number, platformRefusal };
}

/** This turn is the newest message back to the user message that started it. */
export function summarizeChatGptToolRecord(record: unknown): ChatGptToolRecordEvidence | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const { currentNode, nodes } = record as { currentNode?: unknown; nodes?: unknown };
  if (typeof currentNode !== "string" || !nodes || typeof nodes !== "object" || Array.isArray(nodes)) return undefined;
  const byId = nodes as Record<string, RecordNode>;
  const turn: RecordNode[] = [];
  const seen = new Set<string>();
  for (let id: string | null = currentNode; id !== null && byId[id] && !seen.has(id); id = byId[id]!.parent) {
    seen.add(id);
    if (byId[id]!.role === "user") break;
    turn.push(byId[id]!);
  }
  if (turn.length === 0) return undefined;
  const platform = (node: RecordNode | undefined) => node?.role === "tool" || node?.role === "system";
  let unansweredCalls = 0;
  let platformRefusal = false;
  for (const node of turn) {
    const replies = node.children.map(child => byId[child]).filter(platform);
    if (node.role === "assistant" && node.recipient && node.recipient !== "all" && replies.length === 0) {
      unansweredCalls += 1;
    }
    for (const message of [node, ...replies]) {
      if (platform(message) && PLATFORM_REFUSAL.test(message!.text)) platformRefusal = true;
    }
  }
  return { unansweredCalls, platformRefusal };
}

/**
 * Runs in the page, and must stay self-contained for that. The session token it needs to read the
 * conversation never leaves the page; only the tree shape and each message's text come back.
 */
export async function fetchChatGptConversationRecord(): Promise<unknown> {
  const match = /^\/c\/([^/?#]+)/.exec(location.pathname);
  if (!match) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const session = await (await fetch("/api/auth/session", {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })).json() as { accessToken?: unknown } | null;
    const token = typeof session?.accessToken === "string" ? session.accessToken : "";
    if (!token) return null;
    const response = await fetch(`/backend-api/conversation/${encodeURIComponent(match[1]!)}`, {
      credentials: "include",
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const conversation = await response.json() as { current_node?: unknown; mapping?: Record<string, any> } | null;
    const nodes: Record<string, unknown> = {};
    for (const [id, node] of Object.entries(conversation?.mapping ?? {})) {
      const message = node?.message;
      nodes[id] = {
        parent: typeof node?.parent === "string" ? node.parent : null,
        children: Array.isArray(node?.children) ? node.children.filter((child: unknown) => typeof child === "string") : [],
        role: typeof message?.author?.role === "string" ? message.author.role : null,
        recipient: typeof message?.recipient === "string" ? message.recipient : null,
        text: message ? JSON.stringify([message.content ?? null, message.metadata ?? null]).slice(0, 4_000) : "",
      };
    }
    return { currentNode: conversation?.current_node ?? null, nodes };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readChatGptToolRecordEvidence(page: Page): Promise<ChatGptToolRecordEvidence | undefined> {
  return summarizeChatGptToolRecord(await page.evaluate(fetchChatGptConversationRecord));
}
