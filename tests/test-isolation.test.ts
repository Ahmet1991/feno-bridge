import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getCodexHome } from "../src/codex-integration-shared";
import { getConfigDir } from "../src/config";
import { restoreTestHomes, TEST_BRIDGE_HOME, TEST_CODEX_HOME } from "./support/isolate-homes";

test("tests resolve throwaway homes, never the live bridge or Codex state", () => {
  expect(resolve(getConfigDir())).toBe(resolve(TEST_BRIDGE_HOME));
  expect(resolve(getCodexHome())).toBe(resolve(TEST_CODEX_HOME));
  expect(resolve(getConfigDir())).not.toBe(resolve(join(homedir(), ".codex-chatgpt-web")));
  expect(resolve(getCodexHome())).not.toBe(resolve(join(homedir(), ".codex")));
});

test("restoring after a test returns to the throwaway homes instead of the live defaults", () => {
  // Read through a function: after `delete`, TypeScript narrows a direct property read to undefined.
  const read = (name: string) => process.env[name];
  process.env.CODEX_CHATGPT_WEB_HOME = "/elsewhere/bridge";
  delete process.env.CODEX_HOME;
  restoreTestHomes();
  expect(read("CODEX_CHATGPT_WEB_HOME")).toBe(TEST_BRIDGE_HOME);
  expect(read("CODEX_HOME")).toBe(TEST_CODEX_HOME);
});
