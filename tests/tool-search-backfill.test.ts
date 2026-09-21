import { expect, spyOn, test } from "bun:test";
import { backfillEmptyToolSearchResults } from "../src/adapters/chatgpt-web/tool-search-backfill";
import { searchCodexToolInventory } from "../src/adapters/chatgpt-web/tool-inventory-search";
import { parseRequest } from "../src/responses/parser";
import type { CodexTool } from "../src/types";

const node: CodexTool = {
  name: "js", namespace: "mcp__node_repl", description: "Control Windows apps",
  parameters: { type: "object", properties: { code: { type: "string" } } },
};

function searchRound(
  query: string,
  options: { limit?: number; offset?: number; results?: unknown[]; status?: string } = {},
) {
  return parseRequest({
    model: "chatgpt-web/pro",
    input: [
      { type: "tool_search_call", call_id: "search_1", execution: "client", arguments: {
        query, ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
      } },
      { type: "tool_search_output", call_id: "search_1", status: options.status ?? "completed", tools: options.results ?? [] },
    ],
  });
}

function resultText(parsed: ReturnType<typeof searchRound>): string {
  const message = parsed.context.messages.find(message => message.role === "toolResult" && message.toolName === "tool_search");
  if (!message || message.role !== "toolResult" || typeof message.content !== "string") throw new Error("Missing search result");
  return message.content;
}

test("empty search loads the actual namespaced tool from the registry", () => {
  const parsed = searchRound("mcp__node_repl__js");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    backfillEmptyToolSearchResults(parsed, [node]);
    expect(resultText(parsed)).toContain("mcp__node_repl__js");
    expect(parsed.context.tools).toEqual([node]);
    expect(parsed.context.messages.find(message => message.role === "toolResult")?.isError).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('query="mcp__node_repl__js" matches=1'));
  } finally { warn.mockRestore(); }
});

test("empty search remains empty when the registry has no matching tool", () => {
  const parsed = searchRound("mcp__node_repl__js");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    backfillEmptyToolSearchResults(parsed, [{ ...node, namespace: "mcp__other" }]);
    expect(resultText(parsed)).toBe("Tool search returned no tools.");
    expect(parsed.context.tools).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

test("nonempty native search preserves its content and ordering", () => {
  const results = [
    { type: "function", name: "second", description: "Second", parameters: {} },
    { type: "function", name: "first", description: "First", parameters: {} },
  ];
  const parsed = searchRound("mcp__node_repl__js", { results });
  const initialMessages = structuredClone(parsed.context.messages);
  const initialTools = structuredClone(parsed.context.tools);
  backfillEmptyToolSearchResults(parsed, [node]);
  expect(parsed.context.messages).toEqual(initialMessages);
  expect(parsed.context.tools).toEqual(initialTools);
  expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["second", "first"]);
});

test("backfill applies the same offset and limit as the inventory", () => {
  const registry = [
    { ...node, name: "first", description: "Windows first" },
    { ...node, name: "second", description: "Windows second" },
    { ...node, name: "third", description: "Windows third" },
  ];
  const parsed = searchRound("Windows", { offset: 1, limit: 1 });
  const expected = searchCodexToolInventory(registry, "Windows", 1, 1);
  expect(expected.total).toBe(3);
  backfillEmptyToolSearchResults(parsed, registry);
  expect(parsed.context.tools).toEqual(expected.matches);
  expect(resultText(parsed)).toContain("mcp__node_repl__second");
  expect(resultText(parsed)).not.toContain("mcp__node_repl__first");
  expect(resultText(parsed)).not.toContain("mcp__node_repl__third");
});

test("real client search shape query=mcp__node_repl__js limit=2 resolves to callable wire name", () => {
  const parsed = searchRound("mcp__node_repl__js", { limit: 2 });
  const registry = [
    { ...node, name: "other", description: "Unrelated tool" },
    node,
  ];
  backfillEmptyToolSearchResults(parsed, registry);
  expect(resultText(parsed)).toBe(
    "Tool search loaded these tools — they are now in your available tools. Call one by its EXACT name: mcp__node_repl__js.",
  );
  expect(parsed.context.tools?.map(tool => `${tool.namespace}__${tool.name}`)).toEqual(["mcp__node_repl__js"]);
  expect(parsed.context.tools?.[0]?.parameters).toEqual(node.parameters);
});
