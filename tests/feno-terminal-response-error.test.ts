import { expect, test } from "bun:test";
import { throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";

test("a visible response error action fails fast without depending on localized error text", async () => {
  const invisible = {
    filter() { return this; }, last() { return this; },
    isVisible: async () => false,
  };
  const visible = { last() { return this; }, isVisible: async () => true };
  const scope = {
    getByText: () => invisible,
    getByTestId: (id: string) => id === "regenerate-thread-error-button" ? visible : invisible,
  };

  await expect(throwIfChatGptTerminalErrorAlert(scope as never)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 502,
    code: "upstream_server_error",
    retryable: true,
  });
});
