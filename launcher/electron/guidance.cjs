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

module.exports = { syncBundledGuidance, syncGlobalRouting, ROUTING_SECTION };
