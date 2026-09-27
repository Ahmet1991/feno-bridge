import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { chatGptFailureContext, chatGptPageTextChars } from "../src/adapters/chatgpt-web/browser-worker";

function fakePage(alerts: string[] | Error, pageChars: number | Error): Page {
  return {
    locator: (selector: string) => {
      expect(selector).toBe('[role="alert"]');
      return {
        allInnerTexts: async () => {
          if (alerts instanceof Error) throw alerts;
          return alerts;
        },
      };
    },
    evaluate: async () => {
      if (pageChars instanceof Error) throw pageChars;
      return pageChars;
    },
  } as unknown as Page;
}

test("a dead turn names what ChatGPT showed and how large the page had grown", async () => {
  const context = await chatGptFailureContext(fakePage(["  Something went\n wrong. ", ""], 572_693));
  expect(context).toBe(' (ChatGPT showed: "Something went wrong."; page 572693 chars)');
});

test("alert text is bounded, redacted and capped at three", async () => {
  const long = "x".repeat(400);
  const context = await chatGptFailureContext(fakePage([long, "turn_abcdefghijklmnop failed", "b", "c"], 10));
  expect(context).toContain(`"${"x".repeat(160)}"`);
  expect(context).not.toContain("x".repeat(161));
  expect(context).toContain("turn_[redacted]");
  expect(context).not.toContain('"c"');
});

test("an unreadable page never replaces the failure it decorates", async () => {
  expect(await chatGptFailureContext(fakePage(new Error("detached"), new Error("detached")))).toBe("");
  expect(await chatGptFailureContext({} as Page)).toBe("");
  expect(await chatGptPageTextChars({} as Page)).toBeUndefined();
  expect(await chatGptFailureContext(fakePage([], 0))).toBe(" (page 0 chars)");
});
