import { expect, spyOn, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";
import type { AdapterEvent } from "../src/types";

const agents = [
  "01a20fed-a684-7da1-82db-351cf5b34f18",
  "01a20fed-f53c-7621-9c04-912f8e91f216",
  "01a20fee-4b19-7922-8aec-c3b26a51f1f5",
];
const spawnHistory = agents.flatMap((agent_id, index) => [
  { type: "function_call", namespace: "multi_agent_v1", name: "spawn_agent", call_id: "spawn_" + index, arguments: "{}" },
  { type: "function_call_output", call_id: "spawn_" + index, output: JSON.stringify({ agent_id }) },
]);
const turnIdentity = { thread_id: "thread_native2_wait", turn_id: "turn_native2_wait" };
const native2 = {
  type: "message",
  id: "msg_native2_wait",
  role: "user",
  content: "# Feno: ChatGPT sohbetinden başlatılan görev\nEn çok 3 alt ajan kullan.\n\nÜç sonucun tamamını bekle.",
  internal_chat_message_metadata_passthrough: { turn_id: turnIdentity.turn_id },
};
const tools = [{
  type: "namespace", name: "multi_agent_v1", description: "Native collaboration",
  tools: ["spawn_agent", "wait_agent", "close_agent"].map(name => ({
    type: "function", name, description: name, parameters: { type: "object" },
  })),
}];

test("a premature final waits for all Native2 agents and discards the early answer", async () => {
  const config = defaultConfig("browser-only");
  let rounds = 0;
  async function respond(input: unknown[], previous_response_id?: string) {
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/medium", stream: true, input, tools, previous_response_id,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify(turnIdentity) },
      }),
    }), config, () => ({
      name: "fixture",
      runTurn: async (_parsed, _incoming, emit) => {
        rounds++;
        emit({ type: "text_delta", phase: "final_answer", text: rounds === 1 ? "Premature answer" : "All three results" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }));
    expect(response.status).toBe(200);
    const body = await response.text();
    const completed = body.split("\n").filter(line => line.startsWith("data: {"))
      .map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.completed");
    return { output: completed.response.output, id: completed.response.id, body };
  }
  const waitResult = (call: Record<string, unknown>, status: Record<string, unknown>, timed_out = false) => [
    call,
    { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ status, timed_out }) },
  ];
  const first = await respond([native2, ...spawnHistory]);
  expect(first.body).not.toContain("Premature answer");
  expect(first.output).toHaveLength(1);
  expect(first.output[0]).toMatchObject({ type: "function_call", namespace: "multi_agent_v1", name: "wait_agent" });
  expect(JSON.parse(first.output[0].arguments).targets).toEqual(agents);
  const retried = await respond([native2, ...spawnHistory]);
  expect(JSON.parse(retried.output[0].arguments).targets).toEqual(agents);
  expect(retried.output[0].call_id).toBe(first.output[0].call_id);
  expect(rounds).toBe(1);
  const timedOutHistory = [...spawnHistory, ...waitResult(first.output[0], {}, true)];
  const timedOut = await respond(waitResult(first.output[0], {}, true).slice(1), first.id);
  expect(JSON.parse(timedOut.output[0].arguments).targets).toEqual(agents);
  const partialHistory = [...timedOutHistory, ...waitResult(timedOut.output[0], { [agents[1]!]: { completed: "B" } }), {
    type: "message", role: "user",
    content: [{ type: "input_text", text: `<subagent_notification>\n${JSON.stringify({ agent_path: agents[1], status: { completed: "B" } })}\n</subagent_notification>` }],
  }];
  const partial = await respond([native2, ...partialHistory]);
  expect(JSON.parse(partial.output[0].arguments).targets).toEqual([agents[0], agents[2]]);
  expect(rounds).toBe(1);
  const final = await respond([
    native2, ...partialHistory,
    ...waitResult(partial.output[0], { [agents[0]!]: { completed: "A" }, [agents[2]!]: { completed: "C" } }),
  ]);
  expect(final.body).toContain("All three results");
  expect(final.output.some((item: { type: string }) => item.type === "function_call")).toBe(false);
  expect(rounds).toBe(2);
});

test("a retry cannot reopen the coordinator after its browser release fails", async () => {
  const identity = { ...turnIdentity, turn_id: "turn_native2_wait_release_failure" };
  const release = spyOn(chatGptTurnSessions, "retireSettledTurnForAgentWait")
    .mockRejectedValueOnce(new Error("Retained tab release failed"));
  let rounds = 0;
  const input = [{ ...native2, internal_chat_message_metadata_passthrough: { turn_id: identity.turn_id } }, ...spawnHistory];
  const body = JSON.stringify({
    model: "chatgpt-web/medium", stream: true, input, tools,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(identity) },
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", { method: "POST", body }),
        defaultConfig("browser-only"), () => ({
          name: "fixture",
          runTurn: async (_parsed, _incoming, emit) => {
            rounds++;
            emit({ type: "text_delta", phase: "final_answer", text: "Discarded reply" });
            emit({ type: "done", stopReason: "stop", endTurn: true });
          },
        }));
      const events = await response.text();
      expect(events).toContain("Retained tab release failed");
      expect(events).not.toContain("Discarded reply");
    }
    expect(rounds).toBe(1);
  } finally {
    release.mockRestore();
  }
});

test("a Native2 coordinator still waits after V1 compaction removes spawn results", async () => {
  const identity = { ...turnIdentity, turn_id: "turn_native2_wait_compacted" };
  const input = [{ ...native2, internal_chat_message_metadata_passthrough: { turn_id: identity.turn_id } }, ...spawnHistory];
  const base = { model: "chatgpt-web/medium", stream: false, client_metadata: { "x-codex-turn-metadata": JSON.stringify(identity) } };
  const request = (path: string, body: unknown) => new Request("http://127.0.0.1:17841/v1/" + path, { method: "POST", body: JSON.stringify(body) });
  const config = defaultConfig("browser-only");
  const finish = (text: string) => () => ({
    name: "fixture",
    runTurn: async (_parsed: unknown, _incoming: unknown, emit: (event: AdapterEvent) => void) => {
      emit({ type: "text_delta", phase: "final_answer", text });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  const compacted = await compactRequest(request("responses/compact", { ...base, input }), config, finish("Continue the Native2 task."));
  expect(compacted.status).toBe(200);
  const checkpoint = await compacted.json() as { output: unknown[] };
  const response = await responseRequest(request("responses", { ...base, tools, input: checkpoint.output }), config, finish("Early reply after compaction"));
  const result = await response.json() as { output: Array<{ call_id: string; name: string; arguments: string }> };
  const wait = result.output[0]!;
  expect(wait.name).toBe("wait_agent");
  expect(JSON.parse(wait.arguments).targets).toEqual(agents);
  const settled = { type: "function_call_output", call_id: wait.call_id, output: JSON.stringify({
    status: Object.fromEntries(agents.map(agent => [agent, { completed: "Result" }])), timed_out: false,
  }) };
  const final = await responseRequest(request("responses", { ...base, tools, input: [...checkpoint.output, wait, settled] }),
    config, finish("All results after compaction"));
  expect(await final.text()).toContain("All results after compaction");
});

test("the early root reply retires after physical settlement without cancelling a child tab", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishRoot!: () => void;
  let finishChild!: (answer: string) => void;
  let rootReleases = 0;
  let childCancels = 0;
  const rootKey = "a".repeat(64);
  const childKey = "b".repeat(64);
  const rootText = new ChatGptTextFeed();
  rootText.push("premature");
  const root = sessions.getOrCreate("root", () => ({
    mode: "read-only",
    browser: Promise.resolve("premature"),
    physicalSettlement: new Promise<void>(resolve => { finishRoot = resolve; }),
    trace: new ChatGptTraceFeed(),
    text: rootText,
    conversationKey: rootKey,
    releaseRetainedConversation: async () => { rootReleases++; },
    cancel() {},
  }), "trace-root");
  const childCompletion = new Promise<string>(resolve => { finishChild = resolve; });
  const child = sessions.getOrCreate("child", () => ({
    mode: "read-only",
    browser: childCompletion,
    physicalSettlement: childCompletion.then(() => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: childKey,
    cancel() { childCancels++; },
  }), "trace-child");

  await root.browserOutcome;
  const retired = sessions.retireSettledTurnForAgentWait("trace-root");
  expect(rootReleases).toBe(0);
  finishRoot();
  await retired;
  expect(rootReleases).toBe(1);
  expect(sessions.find("root")).toBeUndefined();
  expect(sessions.find("child")).toBe(child);
  expect(childCancels).toBe(0);
  finishChild("child completed");
  await child.browserOutcome;
});

test("an ordinary Codex task can end while native agents run", async () => {
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/medium", stream: false, input: [{ role: "user", content: "Run in the background" }, ...spawnHistory], tools,
    }),
  }), defaultConfig("browser-only"), () => ({
    name: "fixture",
    runTurn: async (_parsed, _incoming, emit) => {
      emit({ type: "text_delta", phase: "final_answer", text: "Ordinary answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("Ordinary answer");
  expect(body).not.toContain('"name":"wait_agent"');
});
