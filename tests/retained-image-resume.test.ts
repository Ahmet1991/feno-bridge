import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt, countChatGptContextImages } from "../src/adapters/chatgpt-web/prompt";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptPromptFilePayloads } from "../src/adapters/chatgpt-web/browser-worker";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const token = "turn_12345678901234567890123456789012";
const jpeg = (n: number) => `data:image/jpeg;base64,${Buffer.from(`screenshot-${n}`).toString("base64")}`;
const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const answer = (text: string) => ({ role: "assistant", content: [{ type: "output_text", text }] });
const shot = (n: number) => [
  { type: "function_call", name: "codex_view_image", call_id: `call_${n}`, arguments: "{}" },
  { type: "function_call_output", call_id: `call_${n}`, output: [
    { type: "input_image", image_url: jpeg(n), detail: "high" },
  ] },
];
const parse = (input: unknown[]) => parseRequest({ model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: "high" }, input });
const compile = (parsed: ReturnType<typeof parse>) => compileChatGptWebPrompt(parsed, capabilities, token);

test("image from preceding tool-result round reaches the next retained browser prompt", () => {
  const parsed = parse([user("Inspect screenshot"), ...shot(1), answer("Cannot inspect it"), user("Describe the screenshot")]);
  expect(countChatGptContextImages(parsed.context.messages)).toBe(1);
  const resumed = retainedConversationResumeRequest(parsed)!;
  expect(countChatGptContextImages(resumed.context.messages)).toBe(1);
  expect(resumed.context.messages.map(m => m.role)).toEqual(["toolResult", "user"]);
  const prompt = compile(resumed);
  expect(prompt.images).toHaveLength(1);
  expect(prompt.images[0]?.imageUrl).toBe(jpeg(1));
  expect(prompt.text).toContain("image_attachment");
  expect(chatGptPromptFilePayloads(prompt).map(file => file.mimeType)).toEqual(["image/jpeg"]);
});

test("older screenshot is not repeatedly attached and text-only turns keep their original suffix", () => {
  const parsed = parse([user("Inspect"), ...shot(1), answer("Done"), user("Describe"), answer("Seen"), user("Continue")]);
  const resumed = retainedConversationResumeRequest(parsed)!;
  expect(resumed.context.messages.map(m => m.role)).toEqual(["user"]);
  expect(compile(resumed).images).toHaveLength(0);
  const textOnly = parse([user("Task"), answer("Done"), user("Continue")]);
  expect(retainedConversationResumeRequest(textOnly)?.context.messages).toEqual(textOnly.context.messages.slice(-1));
});

test("identical tool-result images are attached once and the most recent 10 survive", () => {
  const raw = [user("Inspect several screenshots"), ...shot(1), ...shot(1),
    ...Array.from({ length: 11 }, (_, i) => shot(i + 2)).flat(), answer("Done"), user("Describe them")];
  const resumed = retainedConversationResumeRequest(parse(raw))!;
  const prompt = compile(resumed);
  expect(prompt.images).toHaveLength(10);
  expect(prompt.images.map(image => image.imageUrl)).toEqual(Array.from({ length: 10 }, (_, i) => jpeg(i + 3)));
});

test("a compiled prompt reports the images its context held, not only the ones it attached", () => {
  const parsed = parse([user("Inspect screenshot"), ...shot(1), answer("Cannot inspect it"), user("Describe it")]);
  const resumed = retainedConversationResumeRequest(parsed)!;
  const prompt = compile(resumed);
  expect(prompt.images).toHaveLength(1);
  expect(prompt.contextImages).toBe(countChatGptContextImages(resumed.context.messages));
  expect(prompt.contextImages).toBe(1);

  // A text-only turn must report zero rather than leaving the field absent. This compile is handed
  // the untrimmed request, so zero here does mean none arrived; on a resumed turn only the
  // separately reported request count can say that.
  const textOnly = compile(parse([user("Task"), answer("Done"), user("Continue")]));
  expect(textOnly.images).toHaveLength(0);
  expect(textOnly.contextImages).toBe(0);
});

test("the reported context image count survives the ten-image attachment cap", () => {
  const shots = Array.from({ length: 13 }, (_, i) => shot(i + 1)).flat();
  const parsed = parse([user("Inspect several"), ...shots, user("Describe them")]);
  const prompt = compile(parsed);
  // The cap keeps the newest ten; the count still names every image the context carried, which is
  // what makes a dropped image distinguishable from one that never arrived.
  expect(prompt.images).toHaveLength(10);
  expect(prompt.contextImages).toBe(13);
});

test("a resume that trims an image reports a context count the request count contradicts", () => {
  // Measured against live requests: once the screenshot round is no longer the most recent round,
  // the retained-resume trim removes it, and the compile then sees a context with no image at all.
  // `contextImages` therefore reads 0 on a request that did carry one — so it can never stand
  // alone in the turn log, and the untrimmed request count has to be reported beside it.
  const parsed = parse([user("Inspect"), ...shot(1), answer("Done"), user("Describe"), answer("Seen"), user("Continue")]);
  const requestImages = countChatGptContextImages(parsed.context.messages);
  expect(requestImages).toBe(1);

  const resumed = retainedConversationResumeRequest(parsed)!;
  const prompt = compile(resumed);
  expect(prompt.images).toHaveLength(0);
  expect(prompt.contextImages).toBe(0);
  expect(requestImages).toBeGreaterThan(prompt.contextImages!);
});
