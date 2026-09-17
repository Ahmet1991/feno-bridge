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

module.exports = { syncBundledGuidance };
