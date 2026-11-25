import { createHash } from "node:crypto";
import type { AdapterEvent, CodexContentPart, CodexParsedRequest } from "../types";
import { namespacedToolName } from "../types";
import { isContextualCodexUserMessage } from "../adapters/chatgpt-web/environment";

export const NATIVE2_TASK_HEADING = "# Feno: ChatGPT sohbetinden başlatılan görev";
const NAMESPACE = "multi_agent_v1";
const WAIT_CALL_PREFIX = "call_feno_native2_wait_";
const AGENT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const terminalStates = ["completed", "errored", "interrupted", "shutdown", "not_found"];

export type Native2Wait = { targets: string[]; round: string; followup: boolean; invalidWaitResult: boolean };

function text(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  return content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsedObject(value: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(value)); } catch { return undefined; }
}

export function pendingNative2AgentWait(parsed: CodexParsedRequest, checkpoint?: Native2Wait): Native2Wait | undefined {
  if (!parsed._compactionRequest && !parsed.context.tools?.some(tool =>
    tool.namespace === NAMESPACE && tool.name === "wait_agent"
  )) return undefined;

  const messages = parsed.context.messages;
  const taskIndex = messages.findLastIndex(message =>
    message.role === "user" && message.origin !== "codex_skill" && !isContextualCodexUserMessage(text(message.content))
  );
  const task = messages[taskIndex];
  if (!checkpoint && (task?.role !== "user" || !text(task.content).startsWith(NATIVE2_TASK_HEADING + "\n"))) return undefined;

  const pending = new Set(checkpoint?.targets);
  let followup = checkpoint?.followup ?? false;
  let invalidWaitResult = checkpoint?.invalidWaitResult ?? false;
  let round = checkpoint?.round ?? "";
  for (const message of messages.slice(taskIndex + 1)) {
    if (message.role !== "toolResult") continue;
    round = message.toolCallId;
    if (message.toolNamespace !== NAMESPACE) continue;
    const result = parsedObject(text(message.content));
    if (message.toolName === "spawn_agent") {
      if (typeof result?.agent_id === "string" && AGENT_ID.test(result.agent_id)) pending.add(result.agent_id);
      followup = false;
      invalidWaitResult = false;
    } else if (message.toolName === "wait_agent") {
      const statuses = object(result?.status);
      const previousSize = pending.size;
      for (const [agentId, state] of Object.entries(statuses ?? {})) {
        const isTerminal = terminalStates.some(status => state === status || Object.hasOwn(object(state) ?? {}, status));
        if (isTerminal) pending.delete(agentId);
      }
      followup = message.toolCallId.startsWith(WAIT_CALL_PREFIX);
      // The native tool returns either a timeout or at least one terminal target.
      // Avoid a tight loop if it rejects our call or returns an unexpected shape.
      invalidWaitResult = followup && (!statuses || (result?.timed_out !== true && pending.size === previousSize));
    }
  }
  return pending.size > 0 ? { targets: [...pending], round, followup, invalidWaitResult } : undefined;
}

export function emitNative2AgentWait(
  wait: Native2Wait,
  emit: (event: AdapterEvent) => void,
  waitKey: string | undefined,
  usage?: Extract<AdapterEvent, { type: "done" }>["usage"],
): void {
  const args = JSON.stringify({ targets: wait.targets, timeout_ms: 30_000 });
  const suffix = waitKey
    ? createHash("sha256").update(JSON.stringify([waitKey, args])).digest("hex").slice(0, 32)
    : crypto.randomUUID();
  emit({ type: "tool_call_start", id: WAIT_CALL_PREFIX + suffix, name: namespacedToolName(NAMESPACE, "wait_agent") });
  emit({ type: "tool_call_delta", arguments: args });
  emit({ type: "tool_call_end" });
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}
