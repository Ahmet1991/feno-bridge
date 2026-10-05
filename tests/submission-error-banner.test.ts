import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { throwIfChatGptSubmissionErrorBanner } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

const { createWindow } = require("@mixmark-io/domino");

// The banner ChatGPT rendered on 06.10 for a refused Bigger Context part, trimmed to its structure.
function bannerHtml(text: string): string {
  return `<aside class="relative flex border-text-danger/20 text-danger" role="alert">`
    + `<div><div class="min-w-0 flex-1">${text}</div></div>`
    + `<div><button type="button">Yeniden dene</button></div></aside>`;
}

function pageWith(html: string, options: { visible?: boolean; throws?: boolean } = {}): Page {
  const window = createWindow(`<main>${html}</main>`);
  const banners = [...window.document.querySelectorAll('[role="alert"]')]
    .filter((element: Element) => (element.getAttribute("class") ?? "").includes("danger"));
  return {
    locator: (selector: string) => {
      if (options.throws) throw new Error("page is gone");
      expect(selector).toBe('[role="alert"][class*="danger"]');
      return {
        count: async () => banners.length,
        last: () => ({
          isVisible: async () => options.visible ?? true,
          evaluate: async (read: (element: Element) => string) => read(banners[banners.length - 1]),
        }),
      };
    },
  } as unknown as Page;
}

async function failure(page: Page, baseline?: number): Promise<ChatGptWebAdapterError | undefined> {
  try {
    await throwIfChatGptSubmissionErrorBanner(page, baseline);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    return error as ChatGptWebAdapterError;
  }
}

test("a too-long banner fails the submission at once and is not retried", async () => {
  for (const text of [
    "Gönderdiğiniz mesaj çok uzun, lütfen düzenleyip yeniden gönderin.",
    "The message you submitted was too long, please reload the conversation and submit something shorter.",
  ]) {
    const error = await failure(pageWith(bannerHtml(text)));
    expect(error?.code).toBe("context_length_exceeded");
    expect(error?.retryable).toBe(false);
    expect(error?.message).toContain(text);
    // The banner's own retry button is not part of the reported text.
    expect(error?.message).not.toContain("Yeniden dene");
  }
});

test("another error banner fails the submission at once but stays retryable", async () => {
  const error = await failure(pageWith(bannerHtml("Bir hata oluştu. Lütfen daha sonra tekrar deneyin.")));
  expect(error?.code).toBe("upstream_server_error");
  expect(error?.retryable).toBe(true);
  expect(error?.message).toContain("Bir hata oluştu");
});

test("only a banner that is new since the baseline, visible and worded belongs to this submission", async () => {
  const stale = bannerHtml("Gönderdiğiniz mesaj çok uzun, lütfen düzenleyip yeniden gönderin.");
  expect(await failure(pageWith(stale), 1)).toBeUndefined();
  expect(await failure(pageWith(stale + stale), 1)).toBeDefined();
  expect(await failure(pageWith(stale, { visible: false }))).toBeUndefined();
  expect(await failure(pageWith(bannerHtml("")))).toBeUndefined();
  // A plain alert without the danger styling, or a page that cannot be read, is not a rejection.
  expect(await failure(pageWith('<div role="alert">Kopyalandı</div>'))).toBeUndefined();
  expect(await failure(pageWith(stale, { throws: true }))).toBeUndefined();
});
