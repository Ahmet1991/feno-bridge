import { afterEach, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

const originalConsoleError = console.error;
afterEach(() => { console.error = originalConsoleError; });

/** Runs one non-streaming turn against an adapter that throws `thrown`, capturing stderr. */
async function turnFailureLogs(thrown: Error): Promise<{ lines: string[]; body: unknown }> {
  const lines: string[] = [];
  console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    adapterFactory: () => ({
      name: "cause-chain-test",
      runTurn: async () => { throw thrown; },
    }),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/high",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fail please" }] }],
      }),
    });
    return { lines, body: await response.json() };
  } finally {
    console.error = originalConsoleError;
    await server.stop(true);
  }
}

// The failure this exists to prevent: a turn dies deep in the browser stack and the only record
// anyone ever sees is the outermost sentence. Every wrap site attaches a cause; before this, not
// one of them was read back anywhere.
test("a thrown cause chain is written to stderr instead of being discarded", async () => {
  const root = new Error("net::ERR_ABORTED at https://chatgpt.com");
  const middle = new Error("locator.click: Timeout 5000ms exceeded", { cause: root });
  const { lines } = await turnFailureLogs(new Error("ChatGPT turn stage failed", { cause: middle }));

  const chain = lines.find(line => line.includes("[bridge] turn failed"));
  expect(chain).toBeDefined();
  expect(chain).toContain("Error: ChatGPT turn stage failed");
  expect(chain).toContain("Error: locator.click: Timeout 5000ms exceeded");
  expect(chain).toContain("Error: net::ERR_ABORTED at https://chatgpt.com");
});

// The detail belongs to the operator, not the model: the response body must not grow.
test("the client still receives only the outermost message", async () => {
  const { body } = await turnFailureLogs(
    new Error("ChatGPT turn stage failed", { cause: new Error("net::ERR_ABORTED") }),
  );
  const message = JSON.stringify(body);
  expect(message).toContain("ChatGPT turn stage failed");
  expect(message).not.toContain("net::ERR_ABORTED");
});

// A plain error has nothing the message does not already say. Logging it anyway would bury the
// chains that matter in noise, which is how a diagnostic stops being read.
test("an error with no cause logs nothing extra", async () => {
  const { lines } = await turnFailureLogs(new Error("plain failure"));
  expect(lines.filter(line => line.includes("[bridge] turn failed"))).toHaveLength(0);
});
