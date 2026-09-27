import { TOOL_SEARCH_EMPTY_RESULT, toolSearchLoadedMessage } from "../../responses/parser";
import { namespacedToolName, type CodexParsedRequest, type CodexTool } from "../../types";
import { searchCodexToolInventory } from "./tool-inventory-search";

const DIRECT_TOOL_HINT_PREFIX = "[Feno Bridge]";

function queryContainsWholeToken(query: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, "i").test(query);
}

function directToolQueryNames(tool: CodexTool): string[] {
  const wireName = namespacedToolName(tool.namespace, tool.name);
  const names = [wireName];
  if (tool.namespace?.startsWith("mcp__")) {
    const server = tool.namespace.slice("mcp__".length);
    if (server.length >= 5 && server.includes("_")) names.push(server);
  }
  return names;
}

function outputToolWireNames(specs: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const value of specs) {
    if (!value || typeof value !== "object") continue;
    const spec = value as Record<string, unknown>;
    if (spec.type === "namespace" && typeof spec.name === "string" && Array.isArray(spec.tools)) {
      for (const innerValue of spec.tools) {
        if (!innerValue || typeof innerValue !== "object") continue;
        const inner = innerValue as Record<string, unknown>;
        if (typeof inner.name === "string") names.add(namespacedToolName(spec.name, inner.name));
      }
    } else if (typeof spec.name === "string") {
      names.add(spec.name);
    }
  }
  return names;
}

function appendDirectToolHint(
  directTools: readonly CodexTool[],
  message: Extract<CodexParsedRequest["context"]["messages"][number], { role: "toolResult" }>,
  query: string,
  outputNames: ReadonlySet<string>,
): void {
  if (typeof message.content !== "string") return;
  const content = message.content;
  const hinted = directTools
    .map(tool => ({ tool, wireName: namespacedToolName(tool.namespace, tool.name) }))
    .filter(({ tool, wireName }) => !outputNames.has(wireName)
      && directToolQueryNames(tool).some(name => queryContainsWholeToken(query, name)))
    .map(({ wireName }) => wireName);
  if (hinted.length === 0) return;

  const unique = [...new Set(hinted)];
  const notes = unique
    .map(name => `${DIRECT_TOOL_HINT_PREFIX} ${name} is already directly callable in this turn; tool_search does not list direct tools. Call it by name.`)
    .filter(note => !content.includes(note));
  if (notes.length === 0) return;
  message.content = `${content}\n${notes.join("\n")}`;
  console.warn(`[chatgpt-web] tool_search direct tool hint query=${JSON.stringify(query)} tools=${unique.join(",")}`);
}

/** Repair empty discovery results and point searches at direct tools that native discovery omits. */
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
    if (call.type !== "tool_search_output" || !Array.isArray(call.tools)
      || (call.status !== undefined && call.status !== "completed" && call.status !== "success")) continue;
    const callId = call.call_id;
    if (typeof callId !== "string") continue;
    const search = searches.get(callId);
    if (!search) continue;
    const message = parsed.context.messages.find(entry => entry.role === "toolResult"
      && entry.toolName === "tool_search" && entry.toolCallId === callId);
    if (!message || message.role !== "toolResult" || message.isError) continue;

    const directToolsBeforeBackfill = [...(parsed.context.tools ?? [])];
    const outputNames = outputToolWireNames(call.tools);
    if (call.tools.length === 0 && message.content === TOOL_SEARCH_EMPTY_RESULT) {
      const { matches } = searchCodexToolInventory(registry, search.query, search.offset, search.limit);
      if (matches.length > 0) {
        const names = matches.map(tool => namespacedToolName(tool.namespace, tool.name));
        message.content = toolSearchLoadedMessage(names);
        for (const name of names) outputNames.add(name);
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
    appendDirectToolHint(directToolsBeforeBackfill, message, search.query, outputNames);
  }
}
