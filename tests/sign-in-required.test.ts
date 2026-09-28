import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

type Cookie = { name: string; value: string };

// 29.09 00:08: ChatGPT ended the session; the launcher refused the redirect to sign-in in the turn
// tab, and Codex saw only "page.goto: net::ERR_ABORTED at https://chatgpt.com/?temporary-chat=true".
function abortedNavigationPage(pageCookies: Cookie[] | Error) {
  return {
    url: () => "about:blank",
    goto: async () => {
      throw new Error("page.goto: net::ERR_ABORTED at https://chatgpt.com/?temporary-chat=true");
    },
    context: () => ({
      cookies: async () => [],
      newCDPSession: async () => ({
        send: async () => {
          if (pageCookies instanceof Error) throw pageCookies;
          return { cookies: pageCookies };
        },
        detach: async () => {},
      }),
    }),
  };
}

function worker() {
  return Object.create(ChatGptBrowserWorker.prototype) as {
    prepareTemporaryChatSurface(page: unknown): Promise<unknown>;
  };
}

test("an aborted Temporary Chat navigation with no session cookie says to sign in again", async () => {
  const failure = await worker().prepareTemporaryChatSurface(
    abortedNavigationPage([{ name: "oai-did", value: "device" }, { name: "__Host-next-auth.csrf-token", value: "x" }]),
  ).catch((error: unknown) => error) as ChatGptWebAdapterError & Error;
  expect(failure).toBeInstanceOf(ChatGptWebAdapterError);
  expect(failure.code).toBe("chatgpt_sign_in_required");
  expect(failure.retryable).toBeFalse();
  expect(failure.message).toContain("Sign in again from Feno Bridge");
});

test("an aborted navigation while signed in keeps its own error", async () => {
  const failure = await worker().prepareTemporaryChatSurface(
    abortedNavigationPage([{ name: "__Secure-next-auth.session-token.0", value: "chunk" }]),
  ).catch((error: unknown) => error) as ChatGptWebAdapterError & Error;
  expect(failure).not.toBeInstanceOf(ChatGptWebAdapterError);
  expect(String(failure.message)).toContain("ERR_ABORTED");
});

test("cookies that cannot be read are not taken as a sign-out", async () => {
  const failure = await worker().prepareTemporaryChatSurface(
    abortedNavigationPage(new Error("Target closed")),
  ).catch((error: unknown) => error) as ChatGptWebAdapterError & Error;
  expect(failure).not.toBeInstanceOf(ChatGptWebAdapterError);
  expect(String(failure.message)).toContain("ERR_ABORTED");
});
