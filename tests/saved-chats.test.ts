import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, chatGptPageIsTemporaryChat } from "../src/adapters/chatgpt-web/browser-worker";

// 19.10: ChatGPT removed connectors and the Personalized control from Temporary Chat, so new
// conversations open as regular saved chats unless Temporary Chats are explicitly configured.

test("a Temporary Chat is recognized before and after it moves to its conversation URL", () => {
  const at = (url: string) => ({ url: () => url });
  expect(chatGptPageIsTemporaryChat(at("https://chatgpt.com/?temporary-chat=true"))).toBe(true);
  expect(chatGptPageIsTemporaryChat(at("https://chatgpt.com/c/6ac7?temporary-chat=true"))).toBe(true);
  expect(chatGptPageIsTemporaryChat(at("https://chatgpt.com/"))).toBe(false);
  expect(chatGptPageIsTemporaryChat(at("https://chatgpt.com/c/6ac7"))).toBe(false);
  expect(chatGptPageIsTemporaryChat(at("about:blank"))).toBe(false);
  expect(chatGptPageIsTemporaryChat({ url: () => { throw new Error("page closed"); } })).toBe(false);
});

test("a new conversation opens as a saved chat by default and as a Temporary Chat only when configured", async () => {
  const opened: string[] = [];
  const stop = new Error("stop after navigation");
  const page = {
    url: () => "about:blank",
    goto: async (url: string) => {
      opened.push(url);
      throw stop;
    },
  };
  const prepare = (ChatGptBrowserWorker.prototype as unknown as {
    prepareTemporaryChatSurface(page: unknown): Promise<unknown>;
  }).prepareTemporaryChatSurface;
  for (const config of [{ appName: "Codex Native2" }, { appName: "Codex Native2", temporaryChats: false }, { appName: "Codex Native2", temporaryChats: true }]) {
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config });
    await expect(prepare.call(worker, page)).rejects.toBe(stop);
  }
  expect(opened).toEqual([
    "https://chatgpt.com/",
    "https://chatgpt.com/",
    "https://chatgpt.com/?temporary-chat=true",
  ]);
});

test("a saved chat selects the connector without the Temporary Chat personalization preflight", async () => {
  let personalizationProbes = 0;
  let reloads = 0;
  const composer = {
    fill: async () => {},
    focus: async () => {},
    evaluate: async () => ({ text: "", focused: true }),
  };
  const untouched = () => {
    personalizationProbes += 1;
    throw new Error("the personalization preflight must not run in a saved chat");
  };
  const page = {
    url: () => "https://chatgpt.com/c/6ac7c1c5-2bb4-83ed-9a65-378df35ea850",
    reload: async () => { reloads += 1; },
    getByRole: untouched,
    getByText: () => ({}),
    locator: (selector: string) => {
      if (selector === "body") return { press: async () => {} };
      if (selector.includes("__menu-item")) return { filter: () => ({}) };
      return untouched();
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2" },
    activeComposer: async () => composer,
    clearChatGptComposerState: async () => {},
    connectorIsSelected: async () => true,
    attachedPromptText: async () => "",
  });
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  await expect(selectConnector.call(worker, page)).resolves.toBe(composer);
  expect(personalizationProbes).toBe(0);
  expect(reloads).toBe(0);
});
