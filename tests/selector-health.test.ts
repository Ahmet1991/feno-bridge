import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { buildSelectorHealthReport, formatSelectorHealthReport, SELECTOR_SPECS } from "../src/selector-health";

const { createWindow } = require("@mixmark-io/domino");
const { measureSelectorHealth } = require("../launcher/electron/selector-health.cjs");

const sampled = SELECTOR_SPECS.filter(spec =>
  ["composer", "effort control", "stop button", "data-turn-id"].includes(spec.name));

function fakeDom(html: string) {
  const window = createWindow(html);
  Object.defineProperty(window.Element.prototype, "getClientRects", {
    configurable: true,
    value(this: HTMLElement) {
      return this.style.display === "none" ? [] : [{}];
    },
  });
  return window.document;
}

function measure(html: string) {
  return measureSelectorHealth(fakeDom(html), sampled, (element: HTMLElement) => ({
    visibility: element.style.visibility || "visible",
  })) as { name: string; matches: number; visible: number }[];
}

test("healthy fake DOM reports required selectors as healthy and absent stop button as state-dependent", () => {
  const observations = measure([
    '<div id="prompt-textarea" contenteditable="true"></div>',
    '<button data-codex-intelligence-trigger="true">Effort</button>',
  ].join(""));
  const report = buildSelectorHealthReport("https://chatgpt.com/?temporary-chat=true", observations, sampled);
  expect(report.ok).toBe(true);
  expect(report.exitCode).toBe(0);
  expect(report.selectors.find(row => row.name === "composer")).toMatchObject({
    matches: 1, visible: 1, verdict: "SAĞLAM",
  });
  expect(report.selectors.find(row => row.name === "effort control")?.verdict).toBe("SAĞLAM");
  expect(report.selectors.find(row => row.name === "stop button")).toMatchObject({
    matches: 0, visible: 0, verdict: "DURUM GEREKTİRİR",
  });
  expect(report.selectors.find(row => row.name === "data-turn-id")?.verdict).toBe("DURUM GEREKTİRİR");
  expect(formatSelectorHealthReport(report)).toContain("DURUM GEREKTİRİR");
});

test("stale fake DOM reports missing composer and effort control as stale with nonzero exit code", () => {
  const observations = measure('<textarea data-new-composer="true"></textarea><button>Other</button>');
  const report = buildSelectorHealthReport("https://chatgpt.com/?temporary-chat=true", observations, sampled);
  expect(report.ok).toBe(false);
  expect(report.exitCode).not.toBe(0);
  expect(report.selectors.find(row => row.name === "composer")).toMatchObject({
    matches: 0, visible: 0, verdict: "BAYAT",
  });
  expect(report.selectors.find(row => row.name === "effort control")?.verdict).toBe("BAYAT");
  expect(report.selectors.find(row => row.name === "stop button")?.verdict).toBe("DURUM GEREKTİRİR");
});

test("visibility is measured independently from DOM presence", () => {
  const observations = measure([
    '<div id="prompt-textarea" style="display:none"></div>',
    '<button data-codex-intelligence-trigger="true" style="visibility:hidden">Effort</button>',
    '<button data-testid="stop-button" style="display:none">Stop</button>',
  ].join(""));
  const report = buildSelectorHealthReport("https://chatgpt.com/?temporary-chat=true", observations, sampled);
  expect(report.selectors.find(row => row.name === "composer")).toMatchObject({
    matches: 1, visible: 0, verdict: "GÖRÜNMÜYOR",
  });
  expect(report.selectors.find(row => row.name === "effort control")?.verdict).toBe("GÖRÜNMÜYOR");
  expect(report.selectors.find(row => row.name === "stop button")?.verdict).toBe("DURUM GEREKTİRİR");
  expect(report.exitCode).toBe(1);
});

test("malformed launcher observations cannot be reported as healthy", () => {
  const valid = measure('<div id="prompt-textarea"></div><button data-codex-intelligence-trigger="true"></button>');
  expect(() => buildSelectorHealthReport("https://chatgpt.com/", valid.slice(1), sampled))
    .toThrow("incomplete selector report");
  expect(() => buildSelectorHealthReport("https://chatgpt.com/", [
    { ...valid[0], visible: valid[0].matches + 1 }, ...valid.slice(1),
  ], sampled)).toThrow("invalid measurements");
});

test("browser selectors CLI returns JSON and a nonzero exit status for stale composer DOM", async () => {
  const root = mkdtempSync(join(tmpdir(), "feno-selector-health-cli-"));
  const home = join(root, "home");
  const descriptorPath = join(home, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  let html = [
    '<div id="prompt-textarea"></div>',
    '<button data-codex-intelligence-trigger="true"></button>',
  ].join("");
  let active = false;
  const control = createServer(async (request, response) => {
    if (request.url !== "/v1/session/selectors"
      || request.headers.authorization !== "Bearer " + "s".repeat(48)) {
      response.writeHead(401);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (active) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "ChatGPT browser is running Codex turn abc123" }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const sampledMeasurements = measure(html);
    const measurements = body.selectors.map((spec: { name: string }) =>
      sampledMeasurements.find(item => item.name === spec.name)
        ?? { name: spec.name, matches: 0, visible: 0 });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ url: "https://chatgpt.com/?temporary-chat=true", measurements }));
  });
  await new Promise<void>((ok, fail) => {
    control.once("error", fail);
    control.listen(0, "127.0.0.1", ok);
  });
  try {
    const address = control.address();
    if (!address || typeof address === "string") throw new Error("Test server has no port");
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(helperScript, "module.exports = {};\n");
    writeFileSync(descriptorPath, JSON.stringify({
      version: 3,
      kind: "codex-web-gpt-launcher",
      profile: "production",
      pid: process.pid,
      endpoint: "http://127.0.0.1:48150",
      control: { endpoint: "http://127.0.0.1:" + address.port, token: "s".repeat(48) },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "a".repeat(32),
      surfaceTargets: { ["a".repeat(32)]: "native-target" },
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      ...defaultConfig("browser-only"),
      browserHost: "launcher",
      browserHostDescriptorPath: descriptorPath,
    }));
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "browser", "selectors", ...args], {
        env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home },
        stdout: "pipe", stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    const healthy = await run(["--json"]);
    expect(healthy.exitCode).toBe(0);
    expect(healthy.stderr).toBe("");
    expect(JSON.parse(healthy.stdout)).toMatchObject({ ok: true, exitCode: 0 });
    expect(JSON.parse(healthy.stdout).selectors).toHaveLength(SELECTOR_SPECS.length);

    html = '<textarea data-new-composer="true"></textarea>';
    const stale = await run([]);
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stdout).toContain("composer");
    expect(stale.stdout).toContain("BAYAT");
    expect(stale.stdout).toContain("DURUM GEREKTİRİR");

    active = true;
    const refused = await run([]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("running Codex turn abc123");
  } finally {
    await new Promise<void>(ok => control.close(() => ok()));
    rmSync(root, { recursive: true, force: true });
  }
});
