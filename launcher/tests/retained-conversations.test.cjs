const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RetainedConversationIndex, restorableConversationUrl } = require("../electron/retained-conversations.cjs");

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);
const PAGE = "https://chatgpt.com/c/6abc309d-db8c-83eb-b94e-161ee410b9bb?temporary-chat=true";
const HOUR = 60 * 60 * 1000;

function scratchFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-retained-"));
  return { file: path.join(root, "retained-conversations.json"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("only a chatgpt.com conversation page is a restorable address", () => {
  assert.equal(restorableConversationUrl(PAGE), PAGE);
  assert.equal(restorableConversationUrl(`${PAGE}#bottom`), PAGE);
  assert.equal(restorableConversationUrl("https://chatgpt.com/?temporary-chat=true"), null);
  assert.equal(restorableConversationUrl("https://chatgpt.com/g/g-abc/c/6abc309d"), null);
  assert.equal(restorableConversationUrl("https://evil.example/c/6abc309d-db8c-83eb"), null);
  assert.equal(restorableConversationUrl("data:text/html,x"), null);
  assert.equal(restorableConversationUrl(undefined), null);
});

test("a remembered conversation survives a restart and is restorable only for its connector", () => {
  const { file, cleanup } = scratchFile();
  try {
    let now = 1_000_000;
    const first = new RetainedConversationIndex({ filePath: file, ttlMs: 12 * HOUR, now: () => now });
    assert.equal(first.remember(KEY, "Codex Native2", PAGE), true);
    const restarted = new RetainedConversationIndex({ filePath: file, ttlMs: 12 * HOUR, now: () => now });
    assert.deepEqual(restarted.restorable(KEY, "Codex Native2"), { url: PAGE });
    assert.equal(restarted.restorable(KEY, "Codex Native2 Kanal2"), null);
    assert.equal(restarted.restorable(OTHER, "Codex Native2"), null);
    now += 12 * HOUR + 1;
    assert.equal(restarted.restorable(KEY, "Codex Native2"), null, "expires with the retained-tab lifetime");
  } finally {
    cleanup();
  }
});

test("a turn writing into the conversation makes it unrestorable until it completes", () => {
  const { file, cleanup } = scratchFile();
  try {
    const index = new RetainedConversationIndex({ filePath: file, ttlMs: 12 * HOUR });
    index.remember(KEY, "Codex Native2", PAGE);
    index.markBusy(KEY);
    assert.equal(index.restorable(KEY, "Codex Native2"), null);
    const restarted = new RetainedConversationIndex({ filePath: file, ttlMs: 12 * HOUR });
    assert.equal(restarted.restorable(KEY, "Codex Native2"), null, "a restart mid-turn never resumes it");
    restarted.remember(KEY, "Codex Native2", PAGE);
    assert.deepEqual(restarted.restorable(KEY, "Codex Native2"), { url: PAGE });
    restarted.forget(KEY);
    assert.equal(new RetainedConversationIndex({ filePath: file, ttlMs: 12 * HOUR }).restorable(KEY, "Codex Native2"), null);
  } finally {
    cleanup();
  }
});

test("invalid keys, pages and damaged files are ignored, and the index stays bounded", () => {
  const { file, cleanup } = scratchFile();
  try {
    const index = new RetainedConversationIndex({ filePath: file, ttlMs: 12 * HOUR, maxEntries: 2 });
    assert.equal(index.remember("not-a-key", "Codex Native2", PAGE), false);
    assert.equal(index.remember(KEY, "Codex Native2", "https://chatgpt.com/?temporary-chat=true"), false);
    let now = 1;
    const bounded = new RetainedConversationIndex({ filePath: file, ttlMs: 12 * HOUR, maxEntries: 2, now: () => now });
    for (const key of ["1", "2", "3"].map(digit => digit.repeat(64))) {
      now += 1;
      bounded.remember(key, "Codex Native2", PAGE);
    }
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.entries.map(entry => entry.key[0]), ["2", "3"], "the oldest entry is dropped");
    fs.writeFileSync(file, "{ not json");
    assert.equal(new RetainedConversationIndex({ filePath: file, ttlMs: 12 * HOUR }).restorable(KEY, "Codex Native2"), null);
  } finally {
    cleanup();
  }
});

test("without a file the index still works in memory", () => {
  const index = new RetainedConversationIndex({ ttlMs: HOUR });
  index.remember(KEY, undefined, PAGE);
  assert.deepEqual(index.restorable(KEY, undefined), { url: PAGE });
});
