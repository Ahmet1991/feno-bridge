const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

// A retained ChatGPT conversation used to live only as an open launcher tab. A restart, the five-tab
// eviction or the 12-hour expiry dropped it, and the next Codex turn resent the whole history as a
// fresh multipart conversation (30.09: 172k tokens in 8 parts, 3.5 minutes before the first reply).
// ChatGPT keeps a temporary chat after its tab closes, so the launcher records where each retained
// conversation lives and can reopen it. An entry is restorable only while its conversation ends at a
// completed turn: a turn that starts in it marks it busy, and only a completed (or untouched) end
// marks it clean again, so a restart in the middle of a turn never resumes a half-written exchange.

const RETAINED_CONVERSATIONS_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 64;
const CONVERSATION_KEY_PATTERN = /^[a-f0-9]{64}$/;

/** The conversation page a retained entry may reopen: a chatgpt.com /c/<id> document, nothing else. */
function restorableConversationUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== "https://chatgpt.com") return null;
  if (!/^\/c\/[A-Za-z0-9-]{8,80}$/.test(url.pathname)) return null;
  url.hash = "";
  return url.toString();
}

class RetainedConversationIndex {
  constructor({ filePath = null, ttlMs, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now, logger } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Retained conversation lifetime must be positive");
    this.filePath = filePath;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.logger = logger;
    this.entries = new Map();
    this.load();
  }

  load() {
    if (!this.filePath) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger?.warn?.("browser.retained_index_unreadable", { message: String(error?.message ?? error) });
      }
      return;
    }
    if (parsed?.version !== RETAINED_CONVERSATIONS_VERSION || !Array.isArray(parsed.entries)) return;
    for (const entry of parsed.entries) {
      const url = restorableConversationUrl(entry?.url);
      if (!url || typeof entry.key !== "string" || !CONVERSATION_KEY_PATTERN.test(entry.key)) continue;
      if (!Number.isFinite(entry.at)) continue;
      this.entries.set(entry.key, {
        url,
        connectorIdentity: typeof entry.connectorIdentity === "string" ? entry.connectorIdentity : undefined,
        at: entry.at,
        clean: entry.clean === true,
      });
    }
    this.prune();
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
    const overflow = this.entries.size - this.maxEntries;
    if (overflow > 0) {
      const oldest = [...this.entries].sort(([, left], [, right]) => left.at - right.at).slice(0, overflow);
      for (const [key] of oldest) this.entries.delete(key);
    }
  }

  persist() {
    if (!this.filePath) return;
    this.prune();
    const entries = [...this.entries].map(([key, entry]) => ({ key, ...entry }));
    try {
      writePrivateFileAtomic(this.filePath, `${JSON.stringify({ version: RETAINED_CONVERSATIONS_VERSION, entries })}\n`);
    } catch (error) {
      this.logger?.warn?.("browser.retained_index_write_failed", { message: String(error?.message ?? error) });
    }
  }

  /** The page to reopen for this exact conversation, if it ended at a completed turn and is still fresh. */
  restorable(key, connectorIdentity) {
    if (!key) return null;
    const entry = this.entries.get(key);
    if (!entry || !entry.clean) return null;
    if (entry.connectorIdentity !== connectorIdentity) return null;
    if (entry.at < this.now() - this.ttlMs) return null;
    return { url: entry.url };
  }

  /** The conversation ends at a completed (or untouched) turn on this page. */
  remember(key, connectorIdentity, pageUrl) {
    const url = restorableConversationUrl(pageUrl);
    if (!key || !CONVERSATION_KEY_PATTERN.test(key) || !url) return false;
    this.entries.set(key, { url, connectorIdentity, at: this.now(), clean: true });
    this.persist();
    return true;
  }

  /** A turn is now writing into the conversation; it must not be reopened until that turn completes. */
  markBusy(key) {
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry || !entry.clean) return;
    entry.clean = false;
    this.persist();
  }

  forget(key) {
    if (!key || !this.entries.delete(key)) return;
    this.persist();
  }
}

module.exports = {
  RetainedConversationIndex,
  restorableConversationUrl,
};
