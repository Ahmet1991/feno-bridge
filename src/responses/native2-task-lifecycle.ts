import type { CodexParsedRequest } from "../types";
import { extractChatGptRootThreadMetadata, isContextualCodexUserMessage, type ChatGptTurnIdentity } from "../adapters/chatgpt-web/environment";
import { NATIVE2_TASK_HEADING } from "./native2-agent-wait";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_TASKS = 128;
const MAX_THREADS = 5;

function text(content: CodexParsedRequest["context"]["messages"][number]["content"]): string {
  return typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
}

type Task = { threads: Set<string>; completed: Set<string>; unsafe: boolean };
export class Native2TaskLifecycle {
  private readonly tasks = new Map<string, Task>();

  observe(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity,
    trustedRoot = extractChatGptRootThreadMetadata(parsed)?.threadId === identity.threadId): string | undefined {
    const thread = identity.threadId, turn = identity.turnId;
    if (!thread || !UUID.test(thread) || !turn || identity.parentThreadId || identity.subagentKind) return;
    const key = JSON.stringify([thread, turn]);
    let task = this.tasks.get(key);
    if (!task) {
      const message = parsed.context.messages.findLast(message => message.role === "user"
        && message.origin !== "codex_skill" && !isContextualCodexUserMessage(text(message.content)));
      if (!trustedRoot || !message || !text(message.content).startsWith(NATIVE2_TASK_HEADING + "\n")) return;
      task = { threads: new Set([thread]), completed: new Set(), unsafe: false };
      this.tasks.set(key, task);
      while (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value!);
    }
    for (const message of parsed.context.messages) {
      if (message.role !== "toolResult" || message.toolNamespace !== "multi_agent_v1") continue;
      try {
        const result = JSON.parse(text(message.content));
        if (message.toolName === "spawn_agent" && typeof result?.agent_id === "string" && UUID.test(result.agent_id)) {
          task.threads.add(result.agent_id);
          if (task.threads.size > MAX_THREADS) task.unsafe = true;
        }
        if (message.toolName === "wait_agent" && result?.status && typeof result.status === "object") {
          for (const [id, state] of Object.entries(result.status)) {
            if (!task.threads.has(id) || id === thread) continue;
            if (state === "completed" || (state && typeof state === "object" && Object.hasOwn(state, "completed"))) task.completed.add(id);
            else if (["errored", "interrupted", "shutdown", "not_found"].some(status =>
              state === status || (state && typeof state === "object" && Object.hasOwn(state, status)))) task.unsafe = true;
          }
        }
      } catch { /* Invalid tool results do not prove terminal ownership. */ }
    }
    return !task.unsafe && task.threads.size > 1 && task.completed.size === task.threads.size - 1 ? key : undefined;
  }

  async finish(key: string, release: (threads: ReadonlySet<string>) => Promise<{released: number; pending: number; closedTabs?: number}>): Promise<{released: number; pending: number; tracked: number; closedTabs: number}> {
    const task = this.tasks.get(key);
    if (!task || task.unsafe || task.completed.size !== task.threads.size - 1) throw new Error("Native2 cleanup ownership is unavailable");
    const tracked = task.threads.size;
    let released = 0, closedTabs = 0, pending = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await release(new Set(task.threads));
      released += result.released; closedTabs += result.closedTabs ?? 0; pending = result.pending;
      if (!pending) break;
      if (attempt < 3) await new Promise<void>(resolve => setTimeout(resolve, 250));
    }
    if (!pending) this.tasks.delete(key);
    return { released, closedTabs, pending, tracked };
  }
}

export const native2TaskLifecycle = new Native2TaskLifecycle();
