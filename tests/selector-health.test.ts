import { expect, test } from "bun:test";
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
