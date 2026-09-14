import { expect, test } from "bun:test";
import { formatDoctorReport, type DoctorReport } from "../src/doctor";

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    ok: true,
    mode: "full",
    checks: [{ id: "config", status: "ok", message: "Configuration is valid" }],
    unproven: [],
    ...overrides,
  };
}

test("a fully proven report still summarizes as a plain ready", () => {
  const lines = formatDoctorReport(report({ mode: "browser-only" })).trimEnd().split("\n");
  expect(lines.at(-1)).toBe("Doctor result: ready");
});

test("an unproven connector never summarizes as a plain ready", () => {
  const summary = formatDoctorReport(report({
    checks: [
      { id: "config", status: "ok", message: "Configuration is valid" },
      {
        id: "connector",
        status: "warning",
        unprovenLocally: true,
        message: 'Local checks cannot prove that ChatGPT connector "Codex Native2" is attached to this tunnel',
      },
    ],
    unproven: ["connector"],
  })).trimEnd().split("\n").at(-1)!;

  // The recovery tooling reads this line to decide whether Native2 actually works.
  expect(summary).not.toBe("Doctor result: ready");
  expect(summary).toBe("Doctor result: ready for local checks; unproven from this machine: connector");
});

test("every unproven check is named in the summary", () => {
  const summary = formatDoctorReport(report({ unproven: ["connector", "tunnel-runtime"] }))
    .trimEnd().split("\n").at(-1)!;
  expect(summary).toContain("connector");
  expect(summary).toContain("tunnel-runtime");
});

test("a failing report stays not ready regardless of unproven checks", () => {
  const summary = formatDoctorReport(report({
    ok: false,
    checks: [{ id: "proxy", status: "error", message: "Responses proxy is not reachable" }],
    unproven: ["connector"],
  })).trimEnd().split("\n").at(-1)!;
  expect(summary).toBe("Doctor result: not ready");
});
