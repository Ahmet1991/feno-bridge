import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Locator, Page } from "playwright-core";
import { ChatGptBrowserWorker, mainChatGptComposerIndex } from "../src/adapters/chatgpt-web/browser-worker";

const { createWindow } = require("@mixmark-io/domino");

// The 07.10 page: the message composer sits in the form with the effort control; a second editor
// holding earlier text is outside it.
const composerForm = `<form><div class="ProseMirror" contenteditable="true" role="textbox" id="main"></div>`
  + `<button aria-haspopup="menu" data-tone="neutral">Thinking</button></form>`;
const strayEditor = `<div><div class="ProseMirror" contenteditable="true" role="textbox" id="stray">earlier text</div></div>`;

const globals = globalThis as { getComputedStyle?: unknown };
const originalGetComputedStyle = globals.getComputedStyle;
beforeAll(() => {
  globals.getComputedStyle = (element: Element) => ({
    display: "block", visibility: "visible", opacity: element.getAttribute("data-opacity") ?? "1",
  });
});
afterAll(() => {
  globals.getComputedStyle = originalGetComputedStyle;
});

function composersOf(html: string): Locator & { ids: string[] } {
  const window = createWindow(`<main>${html}</main>`);
  const editors = [...window.document.querySelectorAll('[contenteditable="true"]')] as Element[];
  // Domino has no layout; every editor gets a box, and its opacity comes from data-opacity.
  for (const element of editors) Object.assign(element, { getBoundingClientRect: () => ({ width: 100, height: 20 }) });
  return {
    ids: editors.map(element => element.getAttribute("id") ?? ""),
    count: async () => editors.length,
    first: () => ({ id: editors[0]?.getAttribute("id") }),
    nth: (index: number) => ({ id: editors[index]?.getAttribute("id") }),
    evaluateAll: async <R, A>(read: (elements: Element[], arg: A) => R, arg: A) => read(editors, arg),
  } as unknown as Locator & { ids: string[] };
}

test("the message composer is the one editor whose form carries the effort control", async () => {
  expect(await mainChatGptComposerIndex(composersOf(strayEditor + composerForm))).toBe(1);
  expect(await mainChatGptComposerIndex(composersOf(composerForm + strayEditor))).toBe(0);
  // Without a single owner the choice stays undecided, and the composer wait keeps its old rule.
  expect(await mainChatGptComposerIndex(composersOf(strayEditor + strayEditor))).toBeUndefined();
  expect(await mainChatGptComposerIndex(composersOf(composerForm + composerForm))).toBeUndefined();
});

test("an invisible editor in the composer form does not hide the rendered one", async () => {
  // Playwright's visible filter keeps an editor with opacity 0; both share the effort-control form.
  const twoInOneForm = `<form><div class="ProseMirror" contenteditable="true" role="textbox" data-opacity="0"></div>`
    + `<div class="ProseMirror" contenteditable="true" role="textbox" id="main"></div>`
    + `<button aria-haspopup="menu" data-tone="neutral">Thinking</button></form>`;
  expect(await mainChatGptComposerIndex(composersOf(twoInOneForm))).toBe(1);
});

test("two visible editors no longer fail the turn when one composer owns the effort control", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    activeComposer(page: Page, timeoutMs?: number): Promise<{ id?: string }>;
  };
  const pageWith = (html: string) => ({
    locator: () => ({ filter: () => composersOf(html) }),
  }) as unknown as Page;

  expect(await worker.activeComposer(pageWith(strayEditor + composerForm), 1_000)).toEqual({ id: "main" });
  expect(await worker.activeComposer(pageWith(composerForm), 1_000)).toEqual({ id: "main" });
  await expect(worker.activeComposer(pageWith(strayEditor + strayEditor), 200))
    .rejects.toThrow("ChatGPT composer is unavailable");
});
