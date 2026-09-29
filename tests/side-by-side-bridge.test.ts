import { expect, test } from "bun:test";

// 29.09 "Kanal 2": a second bridge beside the installed one reads its connector name and first
// Responses port from the environment the launcher gives it. Module-level constants, so each case
// runs in its own process.
function configIn(env: Record<string, string>): { name: string; port: number } {
  const run = Bun.spawnSync([process.execPath, "-e",
    'const c = await import("./src/config.ts"); console.log(JSON.stringify({ name: c.CHATGPT_CONNECTOR_NAME, port: c.defaultResponsesPort() }));'],
  { env: { ...process.env, CODEX_WEB_GPT_CONNECTOR_NAME: "", CODEX_WEB_GPT_DEFAULT_PORT: "", ...env } });
  return JSON.parse(run.stdout.toString().trim());
}

test("a second bridge targets its own connector and port", () => {
  expect(configIn({ CODEX_WEB_GPT_CONNECTOR_NAME: "Codex Native2 Kanal2", CODEX_WEB_GPT_DEFAULT_PORT: "17842" }))
    .toEqual({ name: "Codex Native2 Kanal2", port: 17842 });
});

test("without the variables, or with unusable values, the production identity is unchanged", () => {
  expect(configIn({})).toEqual({ name: "Codex Native2", port: 17841 });
  // The Zero Risk and legacy names belong to other connectors; a privileged or bogus port is ignored.
  expect(configIn({ CODEX_WEB_GPT_CONNECTOR_NAME: "Codex Zero Risk", CODEX_WEB_GPT_DEFAULT_PORT: "80" }))
    .toEqual({ name: "Codex Native2", port: 17841 });
  expect(configIn({ CODEX_WEB_GPT_CONNECTOR_NAME: "Codex Native", CODEX_WEB_GPT_DEFAULT_PORT: "yok" }))
    .toEqual({ name: "Codex Native2", port: 17841 });
});
