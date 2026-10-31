import { expect, test } from "bun:test";
import { getRunnerStatus } from "../src/pc-control/runner";

test("runner status verifies the known fenotip-tv label and degrades to unknown offline", async () => {
  await expect(getRunnerStatus({ label: "not-our-runner" as any })).rejects.toThrow("pc_access_denied");
  expect(await getRunnerStatus({ label: "fenotip-tv" })).toEqual({ state: "unknown", source: "not-configured" });
});

test("runner status reports a configured read-only probe without exposing credentials", async () => {
  const answer = await getRunnerStatus({ label: "fenotip-tv" }, async () => ({ state: "online", activeJob: "build-1" }));
  expect(answer).toEqual({ state: "online", source: "configured-probe", activeJob: "build-1" });
});
