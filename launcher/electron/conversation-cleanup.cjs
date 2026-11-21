"use strict";
// Feno opens a saved ChatGPT chat for every Codex task, because Temporary Chat no longer offers the
// connector (19.10). By 21.11 those chats filled the user's history (45 in one day) and buried their
// own conversations. The chats Feno itself created are therefore deleted once the tab that owns
// them closes. Nothing else is touched: an id is recorded only when Feno's own automatic tab moves
// from a new chat to /c/<id> during a running turn, never for a chat the user opened in that tab.
const fs = require("node:fs");

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PENDING_CONVERSATIONS = 500;
const MAX_DELETE_ATTEMPTS = 12;
const DELETE_BATCH_SIZE = 10;
// ChatGPT answers 429 after about thirty quick conversation reads; deletions are spaced well apart.
const DELETE_SPACING_MS = 1500;

function chatGptUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin === CHATGPT_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

function conversationIdFromUrl(raw) {
  const url = chatGptUrl(raw);
  const match = url && /^\/c\/([^/]+)$/.exec(url.pathname);
  return match && CONVERSATION_ID.test(match[1]) ? match[1] : null;
}

/** A new-chat document (saved or temporary), before ChatGPT assigns the conversation an address. */
function isNewChatUrl(raw) {
  return chatGptUrl(raw)?.pathname === "/";
}

/**
 * The page script that deletes the given conversations. It runs inside a chatgpt.com page so the
 * request carries the page's own session; the access token never leaves the page.
 */
function deleteConversationsScript(ids, spacingMs = DELETE_SPACING_MS) {
  if (!Array.isArray(ids) || ids.some(id => !CONVERSATION_ID.test(id))) {
    throw new Error("Conversation ids are invalid");
  }
  return `(async () => {
    const ids = ${JSON.stringify(ids)};
    let token = null;
    try {
      const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store", headers: { accept: "application/json" } });
      const session = response.ok ? await response.json() : null;
      if (session && typeof session.accessToken === "string") token = session.accessToken;
    } catch {}
    if (!token) return ids.map(id => ({ id, status: 0 }));
    const results = [];
    for (const id of ids) {
      if (results.length) await new Promise(resolve => setTimeout(resolve, ${Number(spacingMs)}));
      try {
        const response = await fetch("/backend-api/conversation/" + id, {
          method: "PATCH",
          credentials: "include",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ is_visible: false }),
        });
        results.push({ id, status: response.status });
        if (response.status === 429) break;
      } catch {
        results.push({ id, status: 0 });
      }
    }
    return results;
  })()`;
}

function readPending(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = Array.isArray(parsed?.pending) ? parsed.pending : [];
    return new Map(entries
      .filter(entry => typeof entry?.id === "string" && CONVERSATION_ID.test(entry.id))
      .map(entry => [entry.id, {
        recordedAt: Number.isFinite(entry.recordedAt) ? entry.recordedAt : 0,
        attempts: Number.isSafeInteger(entry.attempts) && entry.attempts > 0 ? entry.attempts : 0,
      }]));
  } catch {
    return new Map();
  }
}

function createConversationCleanup({
  file,
  logger,
  writeFileAtomic,
  now = Date.now,
  spacingMs = DELETE_SPACING_MS,
}) {
  if (typeof file !== "string" || typeof writeFileAtomic !== "function") {
    throw new Error("Conversation cleanup storage is unavailable");
  }
  const pending = readPending(file);
  let sweeping = null;

  function save() {
    const entries = [...pending].map(([id, entry]) => ({ id, ...entry }));
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, pending: entries }, null, 2)}\n`);
    } catch (error) {
      logger?.warn?.("browser.owned_conversations_save_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    record(id) {
      if (typeof id !== "string" || !CONVERSATION_ID.test(id) || pending.has(id)) return false;
      pending.set(id, { recordedAt: now(), attempts: 0 });
      while (pending.size > MAX_PENDING_CONVERSATIONS) {
        const [oldest] = pending.keys();
        pending.delete(oldest);
        logger?.warn?.("browser.owned_conversation_forgotten", { reason: "pending_limit" });
      }
      save();
      return true;
    },

    pendingIds() {
      return [...pending.keys()];
    },

    /**
     * Deletes up to one batch of recorded conversations that no open tab still owns, from the
     * given chatgpt.com page. Failures stay recorded for a later sweep.
     */
    sweep(contents, isOwnedByOpenTab = () => false) {
      if (sweeping) return sweeping;
      sweeping = (async () => {
        if (!contents || contents.isDestroyed?.() || !chatGptUrl(contents.getURL?.())) {
          return { deleted: 0, failed: 0, skipped: "no_chatgpt_page" };
        }
        const ids = [...pending.keys()].filter(id => !isOwnedByOpenTab(id)).slice(0, DELETE_BATCH_SIZE);
        if (ids.length === 0) return { deleted: 0, failed: 0 };
        let results;
        try {
          results = await contents.executeJavaScript(deleteConversationsScript(ids, spacingMs), true);
        } catch (error) {
          logger?.warn?.("browser.owned_conversations_delete_failed", {
            count: ids.length,
            message: error instanceof Error ? error.message : String(error),
          });
          return { deleted: 0, failed: ids.length };
        }
        let deleted = 0;
        let failed = 0;
        const statuses = {};
        for (const result of Array.isArray(results) ? results : []) {
          const entry = pending.get(result?.id);
          if (!entry || !ids.includes(result.id)) continue;
          const status = Number.isSafeInteger(result.status) ? result.status : 0;
          statuses[status] = (statuses[status] || 0) + 1;
          // 404: ChatGPT no longer has it, so there is nothing left to delete.
          if ((status >= 200 && status < 300) || status === 404) {
            pending.delete(result.id);
            deleted += 1;
            continue;
          }
          failed += 1;
          entry.attempts += 1;
          if (entry.attempts >= MAX_DELETE_ATTEMPTS) {
            pending.delete(result.id);
            logger?.warn?.("browser.owned_conversation_forgotten", { reason: "delete_attempts", status });
          }
        }
        save();
        logger?.info?.("browser.owned_conversations_deleted", { deleted, failed, statuses, remaining: pending.size });
        return { deleted, failed };
      })().finally(() => { sweeping = null; });
      return sweeping;
    },
  };
}

module.exports = {
  CONVERSATION_ID,
  DELETE_BATCH_SIZE,
  DELETE_SPACING_MS,
  MAX_DELETE_ATTEMPTS,
  MAX_PENDING_CONVERSATIONS,
  conversationIdFromUrl,
  createConversationCleanup,
  deleteConversationsScript,
  isNewChatUrl,
};
