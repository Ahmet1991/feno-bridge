import { namespacedToolName, type CodexParsedRequest, type CodexTool } from "../../types";
import { searchCodexToolInventory } from "./tool-inventory-search";

/** Restore only successful, empty native discovery results from the actual outer registry. */
export function backfillEmptyToolSearchResults(parsed: CodexParsedRequest, registry: readonly CodexTool[]): void {
  const input = (parsed._rawBody as { input?: unknown }).input;
  if (!Array.isArray(input)) return;

  const searches = new Map<string, { query: string; offset: number; limit: number }>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const call = item as Record<string, unknown>;
    if (call.type === "tool_search_call") {
      if (typeof call.call_id !== "string" || !call.arguments || typeof call.arguments !== "object") continue;
      const args = call.arguments as Record<string, unknown>;
      if (typeof args.query !== "string" || !args.query.trim()) continue;
      searches.set(call.call_id, {
        query: args.query,
        offset: Number.isInteger(args.offset) && (args.offset as number) >= 0 ? args.offset as number : 0,
        limit: Number.isInteger(args.limit) && (args.limit as number) > 0 ? args.limit as number : 20,
      });
      continue;
    }
    if (call.type !== "tool_search_output" || !Array.isArray(call.tools) || call.tools.length !== 0
      || (call.status !== undefined && call.status !== "completed" && call.status !== "success")) continue;
    const callId = call.call_id;
    if (typeof callId !== "string") continue;
    const search = searches.get(callId);
    if (!search) continue;
    const message = parsed.context.messages.find(entry => entry.role === "toolResult"
      && entry.toolName === "tool_search" && entry.toolCallId === callId);
    if (!message || message.role !== "toolResult" || message.isError || message.content !== "Tool search returned no tools.") continue;

    const { matches } = searchCodexToolInventory(registry, search.query, search.offset, search.limit);
    if (matches.length === 0) continue;
    const names = matches.map(tool => namespacedToolName(tool.namespace, tool.name));
    message.content = `Tool search loaded these tools — they are now in your available tools. Call one by its EXACT name: ${names.join(", ")}.`;
    const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
    for (const tool of matches) {
      const name = namespacedToolName(tool.namespace, tool.name);
      if (available.has(name)) continue;
      (parsed.context.tools ??= []).push(tool);
      available.add(name);
    }
    console.warn(`[chatgpt-web] tool_search inventory backfill query=${JSON.stringify(search.query)} matches=${matches.length}`);
  }
}
