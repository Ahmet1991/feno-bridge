import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

type ComposerWorker = {
  activeComposer(page: unknown, timeoutMs?: number): Promise<unknown>;
  temporaryChatComposer(
    page: unknown,
    capture?: (checkpoint: string) => Promise<void>,
    firstWaitMs?: number,
    reloadWaitMs?: number,
  ): Promise<unknown>;
};

function fixture(outcomes: Array<unknown | Error>) {
  const calls: string[] = [];
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async (_page: unknown, timeoutMs?: number) => {
      calls.push(`wait:${timeoutMs}`);
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  }) as ComposerWorker;
  const page = { reload: async () => { calls.push("reload"); } };
  return { worker, page, calls };
}

const unavailable = () => new Error("ChatGPT composer is unavailable. Reload ChatGPT and retry the task.");

test("a Temporary Chat whose editor does not hydrate in time is reloaded once (01.10)", async () => {
  // 01.10 06:46 UTC: two new Temporary Chats after a compaction showed only the server-rendered
  // textarea, and the 30 s wait failed the Codex task both times.
  const composer = { editor: true };
  const { worker, page, calls } = fixture([unavailable(), composer]);
  const checkpoints: string[] = [];
  const result = await worker.temporaryChatComposer(page, async checkpoint => { checkpoints.push(checkpoint); }, 45_000, 60_000);
  expect(result).toBe(composer);
  expect(calls).toEqual(["wait:45000", "reload", "wait:60000"]);
  expect(checkpoints).toEqual(["temporary-chat-composer-reload"]);
});

test("a hydrated editor needs no reload, and a second miss or another error is not retried", async () => {
  const composer = { editor: true };
  const ready = fixture([composer]);
  expect(await ready.worker.temporaryChatComposer(ready.page, undefined, 45_000, 60_000)).toBe(composer);
  expect(ready.calls).toEqual(["wait:45000"]);

  const twice = fixture([unavailable(), unavailable()]);
  await expect(twice.worker.temporaryChatComposer(twice.page, undefined, 45_000, 60_000))
    .rejects.toThrow("ChatGPT composer is unavailable");
  expect(twice.calls).toEqual(["wait:45000", "reload", "wait:60000"]);

  const aborted = fixture([new DOMException("ChatGPT web turn aborted", "AbortError")]);
  await expect(aborted.worker.temporaryChatComposer(aborted.page, undefined, 45_000, 60_000))
    .rejects.toThrow("aborted");
  expect(aborted.calls).toEqual(["wait:45000"]);
});
