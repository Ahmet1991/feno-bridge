const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncBundledGuidance } = require("../electron/guidance.cjs");

const firstGuide = `---\nname: feno-bridge-guide\ndescription: Help with Feno Bridge and Computer Use.\n---\n\n# Feno Bridge guide\n\nFirst edition.\n`;
const secondGuide = firstGuide.replace("First edition.", "Second edition.");

test("a packaged guide reaches the user's Codex skills and updates with the next release", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-guide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "bundle", "SKILL.md");
  const codexHome = path.join(root, "codex");
  const installedPath = path.join(codexHome, "skills", "feno-bridge-guide", "SKILL.md");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, firstGuide);

  assert.equal(syncBundledGuidance({ sourcePath, codexHome }).status, "installed");
  assert.equal(fs.readFileSync(installedPath, "utf8"), firstGuide);
  assert.equal(syncBundledGuidance({ sourcePath, codexHome }).status, "unchanged");

  fs.writeFileSync(sourcePath, secondGuide);
  assert.equal(syncBundledGuidance({ sourcePath, codexHome }).status, "updated");
  assert.equal(fs.readFileSync(installedPath, "utf8"), secondGuide);
  assert.equal(fs.existsSync(path.join(codexHome, "AGENTS.md")), false);
});

test("an existing personal skill is preserved", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-guide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "SKILL.md");
  const codexHome = path.join(root, "codex");
  const installedPath = path.join(codexHome, "skills", "feno-bridge-guide", "SKILL.md");
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.writeFileSync(sourcePath, firstGuide);
  fs.writeFileSync(installedPath, "My own instructions.\n");

  assert.equal(syncBundledGuidance({ sourcePath, codexHome }).status, "conflict");
  assert.equal(fs.readFileSync(installedPath, "utf8"), "My own instructions.\n");
});

test("locally edited installed guidance is preserved during an update", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-guide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "SKILL.md");
  const codexHome = path.join(root, "codex");
  const installedPath = path.join(codexHome, "skills", "feno-bridge-guide", "SKILL.md");
  fs.writeFileSync(sourcePath, firstGuide);
  syncBundledGuidance({ sourcePath, codexHome });
  fs.appendFileSync(installedPath, "My local note.\n");
  fs.writeFileSync(sourcePath, secondGuide);

  assert.equal(syncBundledGuidance({ sourcePath, codexHome }).status, "conflict");
  assert.match(fs.readFileSync(installedPath, "utf8"), /My local note/);
});

test("a Windows CRLF packaged guide is accepted", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-guide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "SKILL.md");
  const codexHome = path.join(root, "codex");
  fs.writeFileSync(sourcePath, firstGuide.replaceAll("\n", "\r\n"));

  assert.equal(syncBundledGuidance({ sourcePath, codexHome }).status, "installed");
});
