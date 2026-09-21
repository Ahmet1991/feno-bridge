import { namespacedToolName, type CodexTool } from "../../types";

/** The direct-registry matching and pagination used by both discovery paths. */
export function searchCodexToolInventory(
  tools: readonly CodexTool[],
  query?: string,
  offset = 0,
  limit = 20,
): { matches: CodexTool[]; total: number } {
  const needle = query?.trim().toLowerCase();
  const matches = tools.filter(tool => !needle || [
    namespacedToolName(tool.namespace, tool.name),
    tool.name,
    tool.namespace ?? "",
    tool.description,
  ].join("\n").toLowerCase().includes(needle));
  return { matches: matches.slice(offset, offset + limit), total: matches.length };
}
