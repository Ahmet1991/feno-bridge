const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  DELETE_BATCH_SIZE,
  MAX_DELETE_ATTEMPTS,
  conversationIdFromUrl,
  createConversationCleanup,
  deleteConversationsScript,
  isNewChatUrl,
} = require("../electron/conversation-cleanup.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

const id = n => `${String(n).padStart(8, "0")}-1111-4222-8333-444444444444`;
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "feno-chats-")), "owned-conversations.json");
const writeFileAtomic = (file, text) => fs.writeFileSync(file, text);

function page(results, url = "https://chatgpt.com/?temporary-chat=true") {
  const scripts = [];
  return {
    scripts,
    getURL: () => url,
    isDestroyed: () => false,
    executeJavaScript: async script => {
      scripts.push(script);
      const ids = JSON.parse(/const ids = (\[.*?\]);/.exec(script)[1]);
      return typeof results === "function" ? results(ids) : ids.map(value => ({ id: value, status: results }));
    },
  };
}

test("only a new chat moving to its own /c/<uuid> address names a Feno conversation", () => {
  assert.equal(conversationIdFromUrl(`https://chatgpt.com/c/${id(1)}`), id(1));
  assert.equal(conversationIdFromUrl(`https://chatgpt.com/c/${id(1)}?model=x`), id(1));
  for (const url of [`https://chatgpt.com/c/${id(1)}/extra`, "https://chatgpt.com/c/not-a-uuid",
    `https://evil.example/c/${id(1)}`, `https://chatgpt.com/g/g-p-1/c/${id(1)}`, "garbage"]) {
    assert.equal(conversationIdFromUrl(url), null, url);
  }
  assert.equal(isNewChatUrl("https://chatgpt.com/"), true);
  assert.equal(isNewChatUrl("https://chatgpt.com/?temporary-chat=true"), true);
  assert.equal(isNewChatUrl(`https://chatgpt.com/c/${id(1)}`), false);
  assert.equal(isNewChatUrl("data:text/html,idle"), false);
});

test("recorded conversations survive a restart and are deleted once no open tab owns them", async () => {
  const file = tempFile();
  const logged = [];
  const logger = { info: (event, detail) => logged.push([event, detail]), warn: (event, detail) => logged.push([event, detail]) };
  const first = createConversationCleanup({ file, logger, writeFileAtomic, spacingMs: 0 });
  assert.equal(first.record(id(1)), true);
  assert.equal(first.record(id(1)), false);
  assert.equal(first.record("../../etc"), false);
  assert.equal(first.record(id(2)), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).pending.map(entry => entry.id), [id(1), id(2)]);

  const restarted = createConversationCleanup({ file, logger, writeFileAtomic, spacingMs: 0 });
  assert.deepEqual(restarted.pendingIds(), [id(1), id(2)]);
  const contents = page(200);
  assert.deepEqual(await restarted.sweep(contents, value => value === id(2)), { deleted: 1, failed: 0 });
  assert.deepEqual(restarted.pendingIds(), [id(2)]);
  assert.ok(!contents.scripts[0].includes(id(2)), "a chat an open tab still owns is not sent for deletion");
  assert.deepEqual(await restarted.sweep(contents), { deleted: 1, failed: 0 });
  assert.deepEqual(restarted.pendingIds(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).pending, []);
  assert.ok(logged.some(([event, detail]) => event === "browser.owned_conversations_deleted" && detail.deleted === 1));
});

test("failed deletions stay recorded, 404 counts as gone, and repeated failures are eventually dropped", async () => {
  const cleanup = createConversationCleanup({ file: tempFile(), writeFileAtomic, spacingMs: 0 });
  cleanup.record(id(1));
  cleanup.record(id(2));
  cleanup.record(id(3));
  const statuses = { [id(1)]: 404, [id(2)]: 500, [id(3)]: 429 };
  assert.deepEqual(await cleanup.sweep(page(ids => ids.map(value => ({ id: value, status: statuses[value] })))), { deleted: 1, failed: 2 });
  assert.deepEqual(cleanup.pendingIds(), [id(2), id(3)]);
  for (let attempt = 1; attempt < MAX_DELETE_ATTEMPTS; attempt += 1) await cleanup.sweep(page(500));
  assert.deepEqual(cleanup.pendingIds(), []);
});

test("a sweep waits for a signed-in chatgpt.com page and sends at most one batch", async () => {
  const cleanup = createConversationCleanup({ file: tempFile(), writeFileAtomic, spacingMs: 0 });
  for (let n = 1; n <= DELETE_BATCH_SIZE + 3; n += 1) cleanup.record(id(n));
  assert.equal((await cleanup.sweep(page(200, "data:text/html,idle"))).skipped, "no_chatgpt_page");
  assert.equal((await cleanup.sweep(null)).skipped, "no_chatgpt_page");
  assert.equal(cleanup.pendingIds().length, DELETE_BATCH_SIZE + 3);
  assert.deepEqual(await cleanup.sweep(page(200)), { deleted: DELETE_BATCH_SIZE, failed: 0 });
  assert.equal(cleanup.pendingIds().length, 3);
  const broken = { getURL: () => "https://chatgpt.com/", isDestroyed: () => false, executeJavaScript: async () => { throw new Error("renderer gone"); } };
  assert.deepEqual(await cleanup.sweep(broken), { deleted: 0, failed: 3 });
  assert.equal(cleanup.pendingIds().length, 3);
});

test("the page script deletes with the page session and never returns the access token", async () => {
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === "/api/auth/session") return { ok: true, json: async () => ({ accessToken: "secret-token" }) };
    return { status: url.endsWith(id(2)) ? 429 : 200 };
  };
  // The script runs in another realm; compare plain copies.
  const results = JSON.parse(JSON.stringify(await vm.runInNewContext(deleteConversationsScript([id(1), id(2), id(3)], 0), { fetch, setTimeout, JSON })));
  assert.deepEqual(results, [{ id: id(1), status: 200 }, { id: id(2), status: 429 }]);
  assert.ok(!JSON.stringify(results).includes("secret-token"));
  const deletion = requests[1];
  assert.equal(deletion.url, `/backend-api/conversation/${id(1)}`);
  assert.equal(deletion.options.method, "PATCH");
  assert.equal(deletion.options.headers.authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(deletion.options.body), { is_visible: false });
  assert.equal(requests.length, 3, "a 429 stops the batch");
  const signedOut = JSON.parse(JSON.stringify(await vm.runInNewContext(deleteConversationsScript([id(1)], 0), {
    fetch: async () => ({ ok: false, status: 401 }), setTimeout, JSON,
  })));
  assert.deepEqual(signedOut, [{ id: id(1), status: 0 }]);
  assert.throws(() => deleteConversationsScript(["1'); alert(1); ('"]), /invalid/);
});

test("browser host records only chats its running automatic tabs create and sweeps after the tab closes", async () => {
  const recorded = [];
  const swept = [];
  const host = {
    turnTabs: new Map(),
    logger: { info() {}, warn() {} },
    conversationCleanup: {
      record: value => recorded.push(value),
      pendingIds: () => recorded,
      sweep: async (contents, owned) => { swept.push({ url: contents?.getURL(), owned: recorded.map(owned) }); return { deleted: 0, failed: 0 }; },
    },
    view: { webContents: { getURL: () => "https://chatgpt.com/?temporary-chat=true", isDestroyed: () => false } },
  };
  const record = (tab, from, to) => BrowserHost.prototype.recordOwnedConversation.call(host, tab, from, to);
  const tab = { id: "t1", status: "running", interactionMode: "automatic" };
  assert.equal(record(tab, "https://chatgpt.com/", `https://chatgpt.com/c/${id(1)}`), true);
  assert.equal(record(tab, `https://chatgpt.com/c/${id(1)}`, `https://chatgpt.com/c/${id(9)}`), false, "the user opening another chat");
  assert.equal(record({ ...tab, status: "ready" }, "https://chatgpt.com/", `https://chatgpt.com/c/${id(8)}`), false);
  assert.equal(record({ ...tab, interactionMode: "manual" }, "https://chatgpt.com/", `https://chatgpt.com/c/${id(7)}`), false);
  assert.equal(record(tab, "https://chatgpt.com/", `https://chatgpt.com/c/${id(1)}`), false, "recorded once");
  assert.deepEqual(recorded, [id(1)]);

  host.turnTabs.set(tab.id, tab);
  await BrowserHost.prototype.sweepOwnedConversations.call(host, 0, true);
  assert.deepEqual(swept.at(-1), { url: "https://chatgpt.com/?temporary-chat=true", owned: [true] });
  host.turnTabs.delete(tab.id);
  assert.equal(BrowserHost.prototype.sweepOwnedConversations.call(host, 1000), null, "throttled between regular sweeps");
  await BrowserHost.prototype.sweepOwnedConversations.call(host, 10 * 60 * 1000);
  assert.deepEqual(swept.at(-1).owned, [false]);
  host.view.webContents.getURL = () => "data:text/html,idle";
  const ready = { status: "ready", view: { webContents: { getURL: () => `https://chatgpt.com/c/${id(5)}`, isDestroyed: () => false } } };
  host.turnTabs.set("t2", ready);
  assert.equal(BrowserHost.prototype.ownedConversationCleanupPage.call(host), ready.view.webContents);
});
