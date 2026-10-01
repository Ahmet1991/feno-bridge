const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function writeAtomically(destination, content) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

function syncBundledGuidance({ sourcePath, codexHome }) {
  const content = fs.readFileSync(sourcePath);
  if (!/^---\r?\nname: feno-bridge-guide\r?\n/.test(content.toString("utf8"))) {
    throw new Error("The bundled Feno Bridge guide is not a valid feno-bridge-guide skill");
  }

  const directory = path.join(codexHome, "skills", "feno-bridge-guide");
  const destination = path.join(directory, "SKILL.md");
  const stamp = path.join(directory, ".feno-bridge.sha256");
  const nextHash = digest(content);
  if (fs.existsSync(destination)) {
    if (!fs.existsSync(stamp)) return { status: "conflict", path: destination };
    const previousHash = fs.readFileSync(stamp, "utf8").trim();
    if (digest(fs.readFileSync(destination)) !== previousHash) {
      return { status: "conflict", path: destination };
    }
    if (previousHash === nextHash) return { status: "unchanged", path: destination };
  }

  fs.mkdirSync(directory, { recursive: true });
  const status = fs.existsSync(destination) ? "updated" : "installed";
  writeAtomically(destination, content);
  writeAtomically(stamp, `${nextHash}\n`);
  return { status, path: destination };
}

const ROUTING_START = "<!-- FENO BRIDGE WINDOWS COMPUTER USE START -->";
const ROUTING_END = "<!-- FENO BRIDGE WINDOWS COMPUTER USE END -->";
const ROUTING_SECTION = `${ROUTING_START}
## Windows Computer Use (Feno Bridge)

For local Windows desktop/app tasks, read the installed \`computer-use:computer-use\` skill first. Discover \`node_repl\` (via \`tool_search\` if deferred), import \`@oai/sky\` there, and verify access with \`sky.list_windows()\` or \`sky.list_apps()\` before selecting a window returned by that call. Consult the installed \`feno-bridge-guide\` skill for the full workflow. Use the browser Computer Use tool for Chrome tabs.

An empty app list or \`Native computer APIs are disabled\` from \`cua_repl\` does not establish that native Windows access is unavailable. Test \`node_repl\` + \`@oai/sky\` before reporting that conclusion. Respect real access denials and confirmation requirements; never bypass security controls.
${ROUTING_END}`;

// The user owns AGENTS.md. Install a short pointer only when one is missing;
// release updates replace the bundled skill, never the user's instructions.
function syncGlobalRouting({ codexHome }) {
  const destination = path.join(codexHome, "AGENTS.md");
  const existing = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : "";
  if (existing.includes(ROUTING_START) || existing.includes(ROUTING_END)) {
    return { status: existing.includes(ROUTING_SECTION) ? "unchanged" : "customized", path: destination };
  }
  // Keep an equivalent personal rule as-is instead of adding a duplicate.
  if (/WINDOWS COMPUTER USE ROUTING/i.test(existing) && /node_repl/i.test(existing) && /@oai\/sky/i.test(existing)) {
    return { status: "existing", path: destination };
  }
  fs.mkdirSync(codexHome, { recursive: true });
  const separator = existing.length && !existing.endsWith("\n") ? "\n\n" : existing.length ? "\n" : "";
  writeAtomically(destination, `${existing}${separator}${ROUTING_SECTION}\n`);
  return { status: existing ? "appended" : "installed", path: destination };
}

// 01.10: through the bridge, jq halved Codex's JSON-log tasks (97 s -> 49 s) and hyperfine
// shortened timing tasks. The Windows runtime bundle ships both (scripts/windows-cli-tools.ts).
// They are copied out of the versioned install into one stable folder, so the path Codex is
// given survives every update. PATH is left alone.
const CLI_TOOL_NAMES = ["jq.exe", "hyperfine.exe"];

function syncCliTools({ sourceDir, coreHome }) {
  if (!CLI_TOOL_NAMES.every(name => fs.existsSync(path.join(sourceDir, name)))) return { status: "missing" };
  const directory = path.join(coreHome, "tools");
  fs.mkdirSync(directory, { recursive: true });
  let changed = 0;
  for (const name of CLI_TOOL_NAMES) {
    const content = fs.readFileSync(path.join(sourceDir, name));
    const destination = path.join(directory, name);
    if (fs.existsSync(destination) && digest(fs.readFileSync(destination)) === digest(content)) continue;
    try {
      writeAtomically(destination, content);
    } catch (error) {
      // Windows refuses to replace an executable while Codex is running it; the copy in place
      // still works, and the next launch replaces it.
      if (error?.code === "EPERM" || error?.code === "EBUSY") return { status: "busy", dir: directory };
      throw error;
    }
    changed += 1;
  }
  return { status: changed ? "updated" : "unchanged", dir: directory };
}

const CLI_TOOLS_START = "<!-- FENO BRIDGE CLI TOOLS START -->";
const CLI_TOOLS_END = "<!-- FENO BRIDGE CLI TOOLS END -->";

function cliToolsSection(toolsDir) {
  // A PowerShell single-quoted string doubles its own quote, which an account name may contain.
  const jq = path.join(toolsDir, "jq.exe").replace(/'/g, "''");
  const hyperfine = path.join(toolsDir, "hyperfine.exe").replace(/'/g, "''");
  return `${CLI_TOOLS_START}
## JSON and timing tools (Feno Bridge)

Feno Bridge installs \`jq\` and \`hyperfine\` in \`${toolsDir}\`, which is not on PATH. Run them with PowerShell's call operator: \`& '${jq}' ...\` and \`& '${hyperfine}' ...\`.

- JSON and JSONL filtering, counting and grouping: use jq rather than \`python -c\`, \`node -e\` or \`ConvertFrom-Json\`. Windows PowerShell 5.1 strips every double quote inside a native command's arguments, \`\\"\` included, and drops an empty \`''\` argument. Never put a double quote in a jq filter: pass each string with \`--arg\` (\`--arg l warning 'select(.level == $l)'\`, regexes too), or put a longer filter in a file and use \`-f filter.jq\`.
- Timing a command: hyperfine with \`-N -w 2 -r 10 "<command>"\` reports mean ± σ, min and max.
${CLI_TOOLS_END}`;
}

// Installed once, like the routing pointer: the user owns AGENTS.md afterwards.
function syncCliToolsRouting({ codexHome, toolsDir }) {
  const destination = path.join(codexHome, "AGENTS.md");
  const existing = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : "";
  const section = cliToolsSection(toolsDir);
  if (existing.includes(CLI_TOOLS_START) || existing.includes(CLI_TOOLS_END)) {
    return { status: existing.includes(section) ? "unchanged" : "customized", path: destination };
  }
  // A personal rule that already puts jq and hyperfine to work is kept instead of duplicated.
  if (/\bjq\b/.test(existing) && /\bhyperfine\b/.test(existing)) return { status: "existing", path: destination };
  fs.mkdirSync(codexHome, { recursive: true });
  const separator = existing.length && !existing.endsWith("\n") ? "\n\n" : existing.length ? "\n" : "";
  writeAtomically(destination, `${existing}${separator}${section}\n`);
  return { status: existing ? "appended" : "installed", path: destination };
}

module.exports = {
  syncBundledGuidance,
  syncGlobalRouting,
  ROUTING_SECTION,
  syncCliTools,
  syncCliToolsRouting,
  cliToolsSection,
  CLI_TOOLS_START,
};
