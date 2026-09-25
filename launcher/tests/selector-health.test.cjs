const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");

const selectors = Array.from({ length: 13 }, (_, index) => ({
  name: "selector-" + index,
  selector: "[data-selector-" + index + "]",
  required: index < 2,
}));

test("selector inspection rejects an active turn before touching its browser page", async () => {
  const host = Object.create(BrowserHost.prototype);
  host.getBrowserInteractionMode = () => "automatic";
  host.ready = async () => {};
  host.turnTabs = new Map([["task", { status: "running", traceId: "active-turn-123" }]]);
  host.view = { webContents: { loadURL() { throw new Error("must not navigate"); } } };
  await assert.rejects(host.inspectSelectors(selectors), /running Codex turn active-turn-123/);
});

test("selector inspection endpoint uses existing host, authenticates and surfaces active-turn refusal", async () => {
  const calls = [];
  let active = false;
  const host = {
    inspectSelectors: async received => {
      if (active) throw new Error("ChatGPT browser is running Codex turn active-turn-123");
      calls.push(received);
      return {
        url: "https://chatgpt.com/?temporary-chat=true",
        measurements: received.map(spec => ({
          name: spec.name, matches: spec.required ? 1 : 0, visible: spec.required ? 1 : 0,
        })),
      };
    },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({}),
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (body, authorization = "Bearer " + token) => fetch(endpoint + "/v1/session/selectors", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await send({ selectors }, "Bearer wrong")).status, 401);
    assert.equal((await send({ selectors: selectors.slice(1) })).status, 400);
    const inspected = await send({ selectors });
    assert.equal(inspected.status, 200);
    const body = await inspected.json();
    assert.equal(body.measurements.length, 13);
    assert.equal(body.measurements[0].visible, 1);
    assert.deepEqual(calls, [selectors]);
    active = true;
    const refused = await send({ selectors });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /running Codex turn active-turn-123/);
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
  }
});
