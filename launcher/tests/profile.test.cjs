const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { migrateLegacyLauncherUserData, resolveLauncherProfile } = require("../electron/profile.cjs");

test("production launcher profile uses the Feno Bridge user-data directory", () => {
  const homeDir = path.resolve("/Users/tester");
  const appData = path.join(homeDir, "Library", "Application Support");
  const production = resolveLauncherProfile({
    argv: ["electron", "."],
    env: {},
    homeDir,
    appData,
  });

  assert.equal(production.userData, path.join(appData, "Feno Bridge"));
  assert.equal(production.legacyUserData, path.join(appData, "Codex Web GPT"));
});

test("legacy launcher data is moved to Feno Bridge without losing files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-profile-migration-"));
  const legacy = path.join(root, "Codex Web GPT");
  const target = path.join(root, "Feno Bridge");
  fs.mkdirSync(path.join(legacy, "logs"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "launcher-state.json"), "state");
  fs.writeFileSync(path.join(legacy, "logs", "latest.log"), "log");

  try {
    assert.equal(migrateLegacyLauncherUserData({ legacyPath: legacy, targetPath: target }), target);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.readFileSync(path.join(target, "launcher-state.json"), "utf8"), "state");
    assert.equal(fs.readFileSync(path.join(target, "logs", "latest.log"), "utf8"), "log");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DEV launcher profile isolates every durable home from production", () => {
  const homeDir = path.resolve("/Users/tester");
  const production = resolveLauncherProfile({
    argv: ["electron", "."],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(production.kind, "production");
  assert.equal(production.displayName, "Feno Bridge");
  assert.equal(development.kind, "development");
  assert.notEqual(development.coreHome, production.coreHome);
  assert.notEqual(development.codexHome, production.codexHome);
  assert.notEqual(development.userData, production.userData);
  assert.notEqual(development.browserPartition, production.browserPartition);
  assert.equal(development.userData, path.join(development.coreHome, "launcher"));
  assert.equal(development.codexHome, path.join(development.coreHome, "codex-home"));
});

test("DEV launcher refuses an explicit home collision with production", () => {
  const homeDir = path.resolve("/Users/tester");
  const shared = path.join(homeDir, "shared");
  assert.throws(() => resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODEX_WEB_GPT_DEV_HOME: shared,
      CODEX_CHATGPT_WEB_HOME: shared,
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  }), /must differ from the production/);
});

test("DEV launcher ignores generic production path overrides", () => {
  const homeDir = path.resolve("/Users/tester");
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODEX_CHATGPT_WEB_HOME: path.join(homeDir, "production-core"),
      CODEX_HOME: path.join(homeDir, "production-codex"),
      CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(homeDir, "production-launcher"),
      CODEX_WEB_GPT_DEV_HOME: path.join(homeDir, "isolated-dev"),
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(development.coreHome, path.join(homeDir, "isolated-dev"));
  assert.equal(development.codexHome, path.join(homeDir, "isolated-dev", "codex-home"));
  assert.equal(development.userData, path.join(homeDir, "isolated-dev", "launcher"));
});
