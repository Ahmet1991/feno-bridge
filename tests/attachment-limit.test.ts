import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { ChatGptAttachmentLimitError, chatGptAttachmentLimitNotice } from "../src/adapters/chatgpt-web/browser-worker";

// 30.09: ChatGPT refused every attachment until 21:45 and said so only inside the composer
// ("Dosya eki limitine ulaştın · 30 Eyl 21:45 sonra tekrar dene"). The turn waited 60 s, reported
// that ChatGPT "did not accept all prompt attachments", and dropped its conversation.

async function noticeIn(html: string): Promise<string | undefined> {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(`<form id="composer">${html}</form>`);
  const innerText = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText");
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true, get() { return this.textContent; },
  });
  const collection = Object.getPrototypeOf(window.document.querySelectorAll("div"));
  const iterator = Object.getOwnPropertyDescriptor(collection, Symbol.iterator);
  Object.defineProperty(collection, Symbol.iterator, { configurable: true, value: Array.prototype[Symbol.iterator] });
  try {
    const context = createContext({ document: window.document, HTMLElement: window.HTMLElement });
    const form = {
      evaluate: async (callback: Function) => runInContext(`(${callback.toString()})`, context)(
        window.document.getElementById("composer"),
      ),
    };
    return await chatGptAttachmentLimitNotice(form as never);
  } finally {
    if (iterator) Object.defineProperty(collection, Symbol.iterator, iterator);
    else delete collection[Symbol.iterator];
    if (innerText) Object.defineProperty(window.HTMLElement.prototype, "innerText", innerText);
    else delete window.HTMLElement.prototype.innerText;
  }
}

test("the composer's attachment-limit notice is read, whatever the prompt says", async () => {
  const editor = '<div contenteditable="true" class="ProseMirror"><p>Fix the rate limit retry</p></div>';
  // Domino's stand-in innerText is textContent, so the line break a browser renders is written out.
  const notice = '<div role="status"><div><p>Dosya eki limitine ulaştın</p>\n<p>30 Eyl 21:45 sonra tekrar dene</p></div>'
    + '<button aria-label="Dosya eki limiti bildirimini kapat"></button></div>';
  expect(await noticeIn(editor + notice)).toBe("Dosya eki limitine ulaştın 30 Eyl 21:45 sonra tekrar dene");
  // The prompt itself saying "limit" is not a notice.
  expect(await noticeIn(editor)).toBeUndefined();
});

test("the limit is a clear rate-limit error that keeps ChatGPT's own words", () => {
  const error = new ChatGptAttachmentLimitError("Dosya eki limitine ulaştın 30 Eyl 21:45 sonra tekrar dene");
  expect(error.code).toBe("chatgpt_attachment_limit");
  expect(error.status).toBe(429);
  expect(error.retryable).toBeFalse();
  expect(error.message).toContain("file attachment limit is reached");
  expect(error.message).toContain("30 Eyl 21:45");
});
