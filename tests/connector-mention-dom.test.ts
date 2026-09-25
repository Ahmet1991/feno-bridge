import { expect, test } from "bun:test";
const { createWindow } = require("@mixmark-io/domino");
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

type ConnectorWorker = {
  connectorMentionRowTitles(rows: unknown): Promise<string[]>;
  connectorMentionFailure(rows: unknown, attempts: number): Promise<string>;
  connectorIsSelected(composer: unknown): Promise<boolean>;
};

function worker(appName = "Codex Native2"): ConnectorWorker {
  return Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName },
  }) as ConnectorWorker;
}

function menuRows(rows: Element[]) {
  return {
    filter: (_options: { visible: boolean }) => ({
      evaluateAll: async (callback: (elements: Element[]) => string[]) => callback(rows),
      count: async () => rows.length,
    }),
  };
}

function composer(html: string) {
  const { document } = createWindow(html);
  const root = document.getElementById("composer")!;
  return {
    locator: (selector: string) => ({
      filter: (_options: { visible: boolean }) => ({
        evaluateAll: async (callback: (elements: Element[]) => (string | null)[]) => (
          callback(Array.from(root.querySelectorAll(selector)))
        ),
      }),
    }),
  };
}

test("legacy connector menu preserves its newline-delimited title", async () => {
  const { document } = createWindow(`<div class="__menu-item" tabindex="0">
    <span>Codex Native2</span><span>Automatic ChatGPT Web bridge to the active local Codex task</span>
  </div>`);
  const row = document.querySelector(".__menu-item")!;
  // Legacy ChatGPT's layout separated the title from the description in innerText.
  Object.defineProperty(row, "innerText", {
    value: "Codex Native2\\nAutomatic ChatGPT Web bridge to the active local Codex task",
  });
  const titles = await worker().connectorMentionRowTitles(menuRows([row]));
  expect(titles).toEqual(["Codex Native2"]);
});

test("current list-navigation rows extract only the first nonempty title leaf", async () => {
  const { document } = createWindow(`
    <button data-list-navigation-item="true">
      <div data-menu-row-content="true"><span><span>Codex Zero Risk</span></span><span>Manual ChatGPT bridge</span></div>
    </button>
    <button data-list-navigation-item="true">
      <div data-menu-row-content="true"><span><span>Codex Native2</span></span><span>Automatic ChatGPT Web bridge to the active local Codex task</span></div>
    </button>
    <button data-list-navigation-item="true">
      <div data-menu-row-content="true"><span>OpenAI Platform</span><span>Developers</span></div>
    </button>
    <button data-list-navigation-item="true">
      <div data-menu-row-content="true"><span>Codex Native2 notes.txt</span><span>Stored file</span></div>
    </button>`);
  const rows = Array.from(document.querySelectorAll('button[data-list-navigation-item="true"]'));
  expect(rows[1]!.textContent).toContain("Codex Native2");
  expect(rows[1]!.textContent).toContain("Automatic ChatGPT Web bridge");
  const titles = await worker().connectorMentionRowTitles(menuRows(rows));
  expect(titles).toEqual([
    "Codex Zero Risk", "Codex Native2", "OpenAI Platform", "Codex Native2 notes.txt",
  ]);
  expect(titles.filter(title => title === "Codex Native2")).toEqual(["Codex Native2"]);
  expect(titles.filter(title => title === "Codex Native")).toEqual([]);
  expect(await worker("Codex Native").connectorMentionFailure(menuRows(rows), 3))
    .toContain('menu opened but exposed no row named "Codex Native"');
});

test("visible menu with unrecognized titles is not reported as an unopened menu", async () => {
  const { document } = createWindow(
    '<button data-list-navigation-item="true"><span>Unrecognized row</span></button>',
  );
  const rows = menuRows(Array.from(document.querySelectorAll("button")));
  expect(await worker().connectorMentionFailure(rows, 3))
    .toContain("menu opened with 1 visible row(s), but their titles could not be recognized");
  expect(await worker().connectorMentionFailure(menuRows([]), 3))
    .toContain("menu did not open (no visible menu rows)");
});

test("selected modern mention uses exact display-name, not slug or visible text", async () => {
  const mention = composer(`<div id="composer">
    <span app-mention-name="codex-native2" app-mention-display-name="Codex Native2"
      app-mention-path="app://asdk_app_test" data-prompt-link-label="$codex-native2"
      contenteditable="false">$codex-native2</span>
  </div>`);
  expect(await worker().connectorIsSelected(mention)).toBeTrue();
  expect(await worker("Codex Native").connectorIsSelected(mention)).toBeFalse();
  expect(await worker("codex-native2").connectorIsSelected(mention)).toBeFalse();
});

test("legacy selected plugin pill is still accepted; duplicate exact mentions are rejected", async () => {
  expect(await worker().connectorIsSelected(composer(`<div id="composer">
    <span data-id="plugin:legacy" data-keyword="Codex Native2">Codex Native2</span>
  </div>`))).toBeTrue();
  await expect(worker().connectorIsSelected(composer(`<div id="composer">
    <span app-mention-display-name="Codex Native2"></span>
    <span app-mention-display-name="Codex Native2"></span>
  </div>`))).rejects.toThrow(/duplicate/);
});
