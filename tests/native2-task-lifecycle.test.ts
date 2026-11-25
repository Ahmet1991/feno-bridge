import { expect, spyOn, test } from "bun:test";
import { responseRequest } from "../src/server";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { Native2TaskLifecycle } from "../src/responses/native2-task-lifecycle";
import { ChatGptTurnSessions, ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";

const root = "01a20000-0000-7000-8000-000000000001";
const a = "01a20000-0000-7000-8000-000000000002";
const b = "01a20000-0000-7000-8000-000000000003";
const foreign = "01a20000-0000-7000-8000-000000000004";
const identity = { threadId: root, turnId: "native2-test-turn" };
const prompt = { type: "message", role: "user", content: "# Feno: ChatGPT sohbetinden başlatılan görev\nAlt ajanları bekle." };
const tool = (name: string, id: string, result: unknown) => [
  { type: "function_call", namespace: "multi_agent_v1", name, call_id: id, arguments: "{}" },
  { type: "function_call_output", call_id: id, output: JSON.stringify(result) },
];
const spawned = [...tool("spawn_agent", "a", { agent_id: a }), ...tool("spawn_agent", "b", { agent_id: b })];
const parse = (input: unknown[]) => parseRequest({ model: "chatgpt-web/medium", input, stream: false });

test("Native2 cleanup requires a trusted root and all actual child results", async () => {
  const lifecycle = new Native2TaskLifecycle();
  const partial = [...spawned, ...tool("wait_agent", "w1", { status: { [a]: { completed: "A" } }, timed_out: false })];
  const complete = [...partial, ...tool("wait_agent", "w2", { status: { [b]: { completed: "B" } }, timed_out: false })];
  expect(lifecycle.observe(parse([prompt, ...complete]), identity, false)).toBeUndefined();
  expect(lifecycle.observe(parse([prompt, ...partial]), identity, true)).toBeUndefined();
  expect(lifecycle.observe(parse([prompt, ...partial, ...tool("wait_agent", "timeout", { status: {}, timed_out: true })]), identity, true)).toBeUndefined();
  const key = lifecycle.observe(parse([prompt, ...complete]), identity, true);
  expect(key).toBeDefined();
  let targets: string[] = [];
  const result = await lifecycle.finish(key!, async threads => { targets = [...threads]; return { released: 3, pending: 0 }; });
  expect(targets).toEqual([root, a, b]);
  expect(result).toEqual({ tracked: 3, released: 3, pending: 0, closedTabs: 0 });
});

test("failed agents, child requests and unrelated roots cannot trigger cleanup", () => {
  const lifecycle = new Native2TaskLifecycle();
  const failed = [...spawned, ...tool("wait_agent", "failed", { status: { [a]: { completed: "A" }, [b]: { errored: "B" } } })];
  expect(lifecycle.observe(parse([prompt, ...failed]), identity, true)).toBeUndefined();
  expect(lifecycle.observe(parse([prompt, ...failed]), { ...identity, threadId: a, parentThreadId: root, subagentKind: "thread_spawn" }, true)).toBeUndefined();
  expect(lifecycle.observe(parse([{ type: "message", role: "user", content: "ordinary task" }, ...failed]), { ...identity, threadId: foreign }, true)).toBeUndefined();
});

test("release only physically settled conversations for exact task threads; preserve replay", async () => {
  const sessions = new ChatGptTurnSessions();
  const released: string[] = [];
  let finishChild!: (answer: string) => void;
  const childBrowser = new Promise<string>(resolve => { finishChild = resolve; });
  const create = (id: string, thread: string, key: string, browser = Promise.resolve(id)) =>
    sessions.getOrCreate(id, () => ({
      mode: "read-only", browser, physicalSettlement: browser.then(() => undefined),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), conversationKey: key,
      releaseRetainedConversation: async () => { released.push(id); },
      cancel() { throw Error("cleanup must not cancel sessions"); },
    }), id, undefined, "native2-test-turn", thread);
  const rootSession = create("root", root, "a".repeat(64));
  const childSession = create("child", a, "b".repeat(64), childBrowser);
  const foreignSession = create("foreign", foreign, "c".repeat(64));
  await Promise.all([rootSession.browserOutcome, foreignSession.browserOutcome, rootSession.physicalSettlement, foreignSession.physicalSettlement]);
  expect(await sessions.releaseSettledNativeThreads(new Set([root, a]))).toEqual({ released: 1, pending: 1, closedTabs: 0 });
  expect(released).toEqual(["root"]);
  expect(sessions.find("root")).toBe(rootSession);
  expect(sessions.find("foreign")).toBe(foreignSession);
  expect(foreignSession.conversationKey()).toBe("c".repeat(64));
  finishChild("done");
  await Promise.all([childSession.browserOutcome, childSession.physicalSettlement]);
  expect(await sessions.releaseSettledNativeThreads(new Set([root, a]))).toEqual({ released: 1, pending: 0, closedTabs: 0 });
  expect(released).toEqual(["root", "child"]);
  expect(sessions.find("child")).toBe(childSession);
  expect(sessions.find("root")?.conversationKey()).toBeUndefined();
});

test("canonical Native2 final response releases only its own root and completed child thread IDs", async () => {
  const release = spyOn(chatGptTurnSessions, "releaseSettledNativeThreads").mockResolvedValue({ released: 3, pending: 0, closedTabs: 3 });
  const metadata = { thread_id: root, turn_id: identity.turnId, request_kind: "turn", sandbox_mode: "danger-full-access", agent_name: "/root", workspaces: {} };
  const tools = [{ type: "namespace", name: "multi_agent_v1", description: "agents", tools: ["spawn_agent", "wait_agent"].map(name => ({ type: "function", name, parameters: { type: "object" } })) }];
  const completed = [...spawned, ...tool("wait_agent", "w-final", { status: { [a]: { completed: "A" }, [b]: { completed: "B" } } })];
  try {
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "chatgpt-web/medium", stream: false, input: [prompt, ...completed], tools,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } }),
    }), defaultConfig("browser-only"), () => ({ name: "fixture", runTurn: async (_parsed, _incoming, emit) => {
      emit({ type: "text_delta", phase: "final_answer", text: "verified final" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } }));
    expect(await response.text()).toContain("verified final");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toEqual(new Set([root, a, b]));
  } finally { release.mockRestore(); }
});
