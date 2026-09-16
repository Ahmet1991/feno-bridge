const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PRODUCTION_PROFILE = "production";
const DEVELOPMENT_PROFILE = "development";

function migrateLegacyLauncherUserData({ legacyPath, targetPath }) {
  if (!legacyPath || !targetPath || path.resolve(legacyPath) === path.resolve(targetPath)) return targetPath;
  if (!fs.existsSync(legacyPath)) return targetPath;

  if (fs.existsSync(targetPath)) {
    let backup = path.join(targetPath, "_legacy-backup");
    let suffix = 2;
    while (fs.existsSync(backup)) backup = path.join(targetPath, `_legacy-backup-${suffix++}`);
    fs.renameSync(legacyPath, backup);
    return targetPath;
  }

  try {
    fs.renameSync(legacyPath, targetPath);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    fs.cpSync(legacyPath, targetPath, { recursive: true, errorOnExist: true });
    fs.rmSync(legacyPath, { recursive: true, force: true });
  }
  return targetPath;
}

function resolveUserPath(value, homeDir = os.homedir()) {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(homeDir, value.slice(2));
  }
  return path.resolve(value);
}

function resolveLauncherProfile({
  argv = process.argv,
  env = process.env,
  homeDir = os.homedir(),
  appData,
} = {}) {
  if (typeof appData !== "string" || !path.isAbsolute(appData)) {
    throw new Error("Launcher profile resolution requires an absolute appData path");
  }
  const development = argv.includes("--dev-profile");
  if (!development) {
    const coreHome = env.CODEX_CHATGPT_WEB_HOME?.trim()
      ? resolveUserPath(env.CODEX_CHATGPT_WEB_HOME.trim(), homeDir)
      : path.join(homeDir, ".codex-chatgpt-web");
    const configuredUserData = env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR?.trim();
    const userData = configuredUserData
      ? resolveUserPath(configuredUserData, homeDir)
      : path.join(appData, "Feno Bridge");
    return {
      kind: PRODUCTION_PROFILE,
      displayName: "Feno Bridge",
      coreHome,
      codexHome: env.CODEX_HOME?.trim()
        ? resolveUserPath(env.CODEX_HOME.trim(), homeDir)
        : path.join(homeDir, ".codex"),
      userData,
      legacyUserData: configuredUserData ? null : path.join(appData, "Codex Web GPT"),
      browserPartition: "persist:codex-web-gpt-chatgpt",
    };
  }

  const coreHome = env.CODEX_WEB_GPT_DEV_HOME?.trim()
    ? resolveUserPath(env.CODEX_WEB_GPT_DEV_HOME.trim(), homeDir)
    : path.join(homeDir, ".codex-chatgpt-web-dev");
  const productionHome = env.CODEX_CHATGPT_WEB_HOME?.trim()
    ? resolveUserPath(env.CODEX_CHATGPT_WEB_HOME.trim(), homeDir)
    : path.join(homeDir, ".codex-chatgpt-web");
  if (path.resolve(coreHome) === path.resolve(productionHome)) {
    throw new Error("DEV profile home must differ from the production codex-chatgpt-web home");
  }
  return {
    kind: DEVELOPMENT_PROFILE,
    displayName: "Feno Bridge DEV",
    coreHome,
    codexHome: path.join(coreHome, "codex-home"),
    userData: path.join(coreHome, "launcher"),
    browserPartition: "persist:codex-web-gpt-dev-chatgpt",
  };
}

module.exports = {
  DEVELOPMENT_PROFILE,
  PRODUCTION_PROFILE,
  migrateLegacyLauncherUserData,
  resolveLauncherProfile,
};
