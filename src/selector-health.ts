import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
} from "./chatgpt-session";
import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";

export type SelectorSpec = { name: string; selector: string; required: boolean };
export type SelectorMeasurement = { name: string; matches: number; visible: number };
export type SelectorVerdict = "SAĞLAM" | "BAYAT" | "DURUM GEREKTİRİR" | "GÖRÜNMÜYOR";

export const SELECTOR_SPECS: readonly SelectorSpec[] = [
  { name: "composer", selector: CHATGPT_COMPOSER_SELECTOR, required: true },
  { name: "effort control", selector: CHATGPT_EFFORT_CONTROL_SELECTOR, required: true },
  { name: "effort menu", selector: CHATGPT_EFFORT_MENU_SELECTOR, required: false },
  { name: "effort item", selector: CHATGPT_EFFORT_ITEM_SELECTOR, required: false },
  { name: "effort slider container", selector: CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR, required: false },
  { name: "effort slider", selector: CHATGPT_EFFORT_SLIDER_SELECTOR, required: false },
  // Situational: an empty composer shows voice input in place of Send.
  { name: "send button", selector: CHATGPT_SEND_BUTTON_SELECTOR, required: false },
  { name: "stop button", selector: CHATGPT_STOP_BUTTON_SELECTOR, required: false },
  { name: "completion action", selector: CHATGPT_COMPLETION_ACTION_SELECTOR, required: false },
  { name: "assistant turn", selector: CHATGPT_ASSISTANT_TURN_SELECTOR, required: false },
  { name: "user turn", selector: CHATGPT_USER_TURN_SELECTOR, required: false },
  { name: "data-turn-id", selector: "[data-turn-id]", required: false },
  { name: "data-turn-id-container", selector: "[data-turn-id-container]", required: false },
  { name: "data-content-search-unit-key", selector: "[data-content-search-unit-key]", required: false },
  { name: "data-turn-key", selector: "[data-turn-key]", required: false },
  { name: "data-conversation-role", selector: "[data-conversation-role]", required: false },
];

export type SelectorHealthRow = SelectorMeasurement & {
  selector: string;
  required: boolean;
  verdict: SelectorVerdict;
};
export type SelectorHealthReport = {
  url: string;
  ok: boolean;
  exitCode: number;
  selectors: SelectorHealthRow[];
};

export function buildSelectorHealthReport(
  url: string,
  measurements: readonly SelectorMeasurement[],
  specs: readonly SelectorSpec[] = SELECTOR_SPECS,
): SelectorHealthReport {
  if (measurements.length !== specs.length) throw new Error("Launcher returned an incomplete selector report");
  const selectors = specs.map((spec, index): SelectorHealthRow => {
    const measured = measurements[index];
    if (measured?.name !== spec.name
      || !Number.isSafeInteger(measured.matches) || measured.matches < 0
      || !Number.isSafeInteger(measured.visible) || measured.visible < 0
      || measured.visible > measured.matches) {
      throw new Error("Launcher returned invalid measurements for " + spec.name);
    }
    const verdict: SelectorVerdict = measured.matches === 0
      ? (spec.required ? "BAYAT" : "DURUM GEREKTİRİR")
      : measured.visible === 0
        ? (spec.required ? "GÖRÜNMÜYOR" : "DURUM GEREKTİRİR")
        : "SAĞLAM";
    return { ...measured, selector: spec.selector, required: spec.required, verdict };
  });
  const ok = selectors.every(row => !row.required || row.verdict === "SAĞLAM");
  return { url, ok, exitCode: ok ? 0 : 1, selectors };
}

export function formatSelectorHealthReport(report: SelectorHealthReport): string {
  const headers = ["Ad", "Eşleşme", "Görünür", "Hüküm"];
  const data = report.selectors.map(row => [
    row.name, String(row.matches), String(row.visible), row.verdict,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...data.map(row => row[index].length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  return [
    "Geçici Sohbet: " + report.url,
    line(headers),
    widths.map(width => "-".repeat(width)).join("  "),
    ...data.map(line),
    "Sonuç: " + (report.ok ? "SAĞLAM" : "ZORUNLU SEÇİCİ HATASI"),
    "",
  ].join("\n");
}

export async function inspectLauncherSelectors(descriptorPath: string): Promise<SelectorHealthReport> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(descriptor.control.endpoint + "/v1/session/selectors", {
      method: "POST",
      headers: {
        authorization: "Bearer " + descriptor.control.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ selectors: SELECTOR_SPECS }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(typeof result.error === "string"
        ? result.error
        : "Launcher selector inspection failed (HTTP " + response.status + ")");
    }
    if (typeof result.url !== "string" || !Array.isArray(result.measurements)) {
      throw new Error("Launcher returned malformed selector inspection evidence");
    }
    return buildSelectorHealthReport(result.url, result.measurements as SelectorMeasurement[]);
  } finally {
    clearTimeout(timeout);
  }
}
