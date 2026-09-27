import { expect, spyOn, test } from "bun:test";
import { backfillEmptyToolSearchResults } from "../src/adapters/chatgpt-web/tool-search-backfill";
import { searchCodexToolInventory } from "../src/adapters/chatgpt-web/tool-inventory-search";
import { parseRequest } from "../src/responses/parser";
import type { CodexTool } from "../src/types";

const node: CodexTool = {
  name: "js", namespace: "mcp__node_repl", description: "Control Windows apps",
  parameters: { type: "object", properties: { code: { type: "string" } } },
};

const cua: CodexTool = {
  name: "js", namespace: "mcp__cua_repl", description: "Control Chrome tabs",
  parameters: { type: "object", properties: { code: { type: "string" } } },
};

const cuaHint = "[Feno Bridge] mcp__cua_repl__js is already directly callable in this turn; tool_search does not list direct tools. Call it by name.";
const nodeHint = "[Feno Bridge] mcp__node_repl__js is already directly callable in this turn; tool_search does not list direct tools. Call it by name.";

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

test("empty-search backfill does not add a redundant direct-tool hint when it loads that tool", () => {
  const parsed = searchRound("mcp__cua_repl__js");
  parsed.context.tools = [cua];
  backfillEmptyToolSearchResults(parsed, [cua]);
  expect(resultText(parsed)).toContain("mcp__cua_repl__js");
  expect(resultText(parsed)).not.toContain("[Feno Bridge]");
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

test.each([
  "node_repl js cua_repl browser Chrome calculator Windows screenshot click",
  "cua_repl computer use browser createBrowserTab getAXState click",
])("live query appends a direct-tool hint when tool_search cannot list the direct tool: %s", query => {
  const parsed = searchRound(query, {
    results: [{ type: "function", name: "calculator", description: "Calculator", parameters: {} }],
  });
  parsed.context.tools = [...(parsed.context.tools ?? []), cua];
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    backfillEmptyToolSearchResults(parsed, [cua]);
    expect(resultText(parsed)).toContain(cuaHint);
    expect(warn).toHaveBeenCalledWith(
      `[chatgpt-web] tool_search direct tool hint query=${JSON.stringify(query)} tools=mcp__cua_repl__js`,
    );
  } finally { warn.mockRestore(); }
});

test("live query names every matching direct tool", () => {
  const query = "node_repl js cua_repl browser Chrome calculator Windows screenshot click";
  const parsed = searchRound(query, {
    results: [{ type: "function", name: "calculator", description: "Calculator", parameters: {} }],
  });
  parsed.context.tools = [...(parsed.context.tools ?? []), node, cua];
  backfillEmptyToolSearchResults(parsed, [node, cua]);
  expect(resultText(parsed)).toContain(nodeHint);
  expect(resultText(parsed)).toContain(cuaHint);
});

test("does not append a hint when the query does not name the direct tool", () => {
  const parsed = searchRound("calculator Windows screenshot click", {
    results: [{ type: "function", name: "calculator", description: "Calculator", parameters: {} }],
  });
  parsed.context.tools = [...(parsed.context.tools ?? []), cua];
  backfillEmptyToolSearchResults(parsed, [cua]);
  expect(resultText(parsed)).not.toContain("[Feno Bridge]");
});

test("does not append a hint when tool_search already returned the direct tool", () => {
  const parsed = searchRound("cua_repl browser", {
    results: [{ type: "function", name: "mcp__cua_repl__js", description: "Chrome", parameters: {} }],
  });
  parsed.context.tools = [cua];
  backfillEmptyToolSearchResults(parsed, [cua]);
  expect(resultText(parsed)).not.toContain("[Feno Bridge]");
});

test("does not append a hint for a tool that is not in context.tools", () => {
  const parsed = searchRound("cua_repl browser", {
    results: [{ type: "function", name: "calculator", description: "Calculator", parameters: {} }],
  });
  parsed.context.tools = undefined;
  backfillEmptyToolSearchResults(parsed, [cua]);
  expect(resultText(parsed)).not.toContain("[Feno Bridge]");
});

test("generic js and browser terms alone do not trigger a direct-tool hint", () => {
  const parsed = searchRound("js browser Chrome screenshot click", {
    results: [{ type: "function", name: "calculator", description: "Calculator", parameters: {} }],
  });
  parsed.context.tools = [...(parsed.context.tools ?? []), cua];
  backfillEmptyToolSearchResults(parsed, [cua]);
  expect(resultText(parsed)).not.toContain("[Feno Bridge]");
});

test("does not append the same direct-tool hint twice", () => {
  const parsed = searchRound("cua_repl browser", {
    results: [{ type: "function", name: "calculator", description: "Calculator", parameters: {} }],
  });
  parsed.context.tools = [...(parsed.context.tools ?? []), cua];
  backfillEmptyToolSearchResults(parsed, [cua]);
  backfillEmptyToolSearchResults(parsed, [cua]);
  expect(resultText(parsed).split(cuaHint)).toHaveLength(2);
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
