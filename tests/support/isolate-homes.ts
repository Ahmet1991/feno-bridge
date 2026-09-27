import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded by bunfig.toml before any test file. Tests run on developer machines next to a live
// bridge: without this, a test that reaches the response store with no home configured loads the
// live ~/.codex-chatgpt-web/responses-state.json into its own process and later writes its whole
// store back over it, racing the running daemon (27.09: three server tests left eleven fixture
// chains in the live snapshot). CODEX_HOME is isolated for the same reason: an afterEach that
// deleted it sent later files to the user's real ~/.codex. A test that needs another home still
// sets one; restoring means returning to these values, never to the live defaults.
const root = mkdtempSync(join(tmpdir(), "feno-test-homes-"));
export const TEST_BRIDGE_HOME = join(root, "codex-chatgpt-web");
export const TEST_CODEX_HOME = join(root, "codex");

/** What an afterEach calls instead of deleting either variable. */
export function restoreTestHomes(): void {
  process.env.CODEX_CHATGPT_WEB_HOME = TEST_BRIDGE_HOME;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
}

restoreTestHomes();

process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});
