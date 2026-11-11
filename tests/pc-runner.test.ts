import { expect, test } from "bun:test";
import { getRunnerStatus, createConfiguredGithubRunnerProbe } from "../src/pc-control/runner";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("runner status verifies the known fenotip-tv label and degrades to unknown offline", async () => {
  await expect(getRunnerStatus({ label: "not-our-runner" as any })).rejects.toThrow("pc_access_denied");
  expect(await getRunnerStatus({ label: "fenotip-tv" })).toEqual({ state: "unknown", source: "not-configured" });
});

test("runner status reports a configured read-only probe without exposing credentials", async () => {
  const answer = await getRunnerStatus({ label: "fenotip-tv" }, async () => ({ state: "online", activeJob: "build-1" }));
  expect(answer).toEqual({ state: "online", source: "configured-probe", activeJob: "build-1" });
});

const configuration = { schema: 1, repository: "Ahmet1991/AkentekIPTV", runnerName: "fenotip-vestel-pc", label: "fenotip-tv" };
function configuredProbe(body: unknown, override: unknown = configuration) {
  const directory = mkdtempSync(join(tmpdir(), "pc-runner-probe-"));
  writeFileSync(join(directory, "pc-runner.json"), JSON.stringify(override));
  const commands: { executable: string; args: string[] }[] = [];
  const probe = createConfiguredGithubRunnerProbe(directory, {
    runCommand: async (executable, args) => { commands.push({ executable, args }); return JSON.stringify(body); },
  });
  return { probe, commands, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("configured probe uses a fixed read-only GitHub request and matches name plus label", async () => {
  const fixture = configuredProbe({ total_count: 2, runners: [
    { name: "another-runner", status: "offline", busy: true, labels: [{ name: "fenotip-tv" }] },
    { name: "fenotip-vestel-pc", status: "online", busy: false, labels: [{ name: "Windows" }, { name: "fenotip-tv" }] },
  ] });
  try {
    expect(await getRunnerStatus({ label: "fenotip-tv" }, fixture.probe)).toEqual({
      state: "online", source: "configured-probe", runnerName: "fenotip-vestel-pc", busy: false,
    });
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]!.args).toEqual(["api", "--hostname", "github.com", "--method", "GET",
      "repos/Ahmet1991/AkentekIPTV/actions/runners?per_page=100"]);
    expect(fixture.commands[0]!.executable).toMatch(/gh(?:\.exe)?$/i);
  } finally { fixture.cleanup(); }
});

test("configured runner reports actual offline and busy flags without inventing a job name", async () => {
  for (const [status, busy] of [["offline", false], ["online", true]] as const) {
    const fixture = configuredProbe({ total_count: 1, runners: [
      { name: "fenotip-vestel-pc", status, busy, labels: [{ name: "fenotip-tv" }] },
    ] });
    try {
      expect(await getRunnerStatus({ label: "fenotip-tv" }, fixture.probe)).toEqual({
        state: status, source: "configured-probe", runnerName: "fenotip-vestel-pc", busy,
      });
    } finally { fixture.cleanup(); }
  }
});

test("missing runner or mismatched label remains unknown rather than borrowing another runner's state", async () => {
  for (const runners of [[], [{ name: "fenotip-vestel-pc", status: "online", busy: false, labels: [{ name: "other-label" }] }]]) {
    const fixture = configuredProbe({ total_count: runners.length, runners });
    try { expect((await getRunnerStatus({ label: "fenotip-tv" }, fixture.probe)).state).toBe("unknown"); }
    finally { fixture.cleanup(); }
  }
});

test("invalid configuration never launches a command and API failures do not expose errors or tokens", async () => {
  for (const repository of ["../../other/repo", "Ahmet1991/AkentekIPTV?access_token=SECRET", "-malicious/repo"]) {
    const fixture = configuredProbe({}, { ...configuration, repository });
    try {
      expect(await getRunnerStatus({ label: "fenotip-tv" }, fixture.probe)).toEqual({ state: "unknown", source: "probe-error" });
      expect(fixture.commands).toHaveLength(0);
    } finally { fixture.cleanup(); }
  }
  const fixture = configuredProbe({ message: "Bearer SECRET_TOKEN" });
  try {
    const result = await getRunnerStatus({ label: "fenotip-tv" }, fixture.probe);
    expect(result).toEqual({ state: "unknown", source: "probe-error" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  } finally { fixture.cleanup(); }
});

test("no local runner configuration preserves not-configured behavior", () => {
  const directory = mkdtempSync(join(tmpdir(), "pc-runner-unconfigured-"));
  try { expect(createConfiguredGithubRunnerProbe(directory)).toBeUndefined(); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});
