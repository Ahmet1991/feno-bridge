import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  activateChatGptEffortMenu,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

test("composer and effort selectors exclude unrelated editable fields and menu buttons", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument(`<body><form>
    <div contenteditable="true" id="unrelated-editor"></div>
    <textarea placeholder="Search" id="search"></textarea>
    <button aria-haspopup="menu" id="attachments"></button>
    <div data-testid="prompt-textarea" id="composer-testid"></div>
    <div id="prompt-textarea"></div>
    <div contenteditable="true" data-lexical-editor="true" id="composer-lexical"></div>
    <div contenteditable="true" data-composer-markdown id="composer-markdown"></div>
    <div class="ProseMirror" contenteditable="true" role="textbox" id="composer-prosemirror"></div>
    <button aria-haspopup="menu" data-tone="neutral" id="effort"></button>
    <button aria-haspopup="menu" data-testid="model-switcher-dropdown-button" id="model"></button>
    <button data-composer-navigation-target="reasoning" aria-haspopup="menu" id="reasoning"></button>
    <button data-codex-intelligence-trigger="true" id="codex-intelligence"></button>
  </form></body>`);
  const matches = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.id);
  expect(matches(CHATGPT_COMPOSER_SELECTOR)).toEqual([
    "composer-testid", "prompt-textarea", "composer-lexical", "composer-markdown", "composer-prosemirror",
  ]);
  expect(matches(CHATGPT_EFFORT_CONTROL_SELECTOR)).toEqual(["effort", "model", "reasoning", "codex-intelligence"]);
});

test("effort slider selectors resolve one container in the measured nested picker", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  // Measured 26.09: the reasoning row CONTAINS the power slider. Matching both would resolve two
  // nested containers, and Playwright's strict waitFor rejects that before any slider is read.
  const document = createDocument(`<body>
    <div data-model-reasoning-effort-slider id="legacy-slider"><span role="slider" id="legacy-input"></span></div>
    <div role="menu">
      <div role="menuitem" data-reasoning-slider="true" id="reasoning-row">
        <div data-menu-row-content>
          <div data-model-picker-power-slider id="power-slider">
            <div data-orientation="horizontal" aria-disabled="false">
              <span data-selected="true"></span><span data-selected="true"></span><span data-selected="true"></span>
              <span role="slider" aria-valuemin="0" aria-valuemax="2" aria-valuenow="2" id="power-input"></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </body>`);
  const matches = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.id);
  expect(matches(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR)).toEqual(["legacy-slider", "power-slider"]);
  expect(matches(CHATGPT_EFFORT_SLIDER_SELECTOR)).toEqual(["legacy-input", "power-input"]);
  const row = document.getElementById("reasoning-row")!;
  expect(Array.from(row.querySelectorAll(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR)).map(element => element.id))
    .toEqual(["power-slider"]);
  expect(row.matches(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR)).toBe(false);
  expect(CHATGPT_EFFORT_MENU_SELECTOR.split("[data-reasoning-slider]")).toHaveLength(4);
});

test("send and stop resolve the composer's primary slot without localized labels", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  // Measured 26.09 in a Turkish UI: no data-testid; Send and Stop share the primary slot styling.
  const form = (generating: boolean) => `<form data-chatgpt-composer>
    <button type="button" class="h-token-button-composer" id="attach" aria-label="Dosya ve daha fazlasını ekle"></button>
    <button type="button" class="h-(--spacing-token-button-composer)" id="model" data-codex-intelligence-trigger="true"></button>
    <button type="button" class="h-token-button-composer" id="dictate" aria-label="Dikte et"></button>
    ${generating
      ? '<button type="button" class="size-token-button-composer bg-composer-primary" id="stop" aria-label="Kapat"></button>'
      : '<button type="submit" class="size-token-button-composer bg-composer-primary" id="send" aria-label="Gönder"></button>'}
  </form>`;
  const matches = (html: string, selector: string) => Array.from(createDocument(`<body>${html}</body>`)
    .querySelectorAll(selector)).map(element => element.id);
  // The stop label above is deliberately not "Durdur": the structural row alone must find it.
  expect(matches(form(true), CHATGPT_STOP_BUTTON_SELECTOR)).toEqual(["stop"]);
  expect(matches(form(true), CHATGPT_SEND_BUTTON_SELECTOR)).toEqual([]);
  expect(matches(form(false), CHATGPT_STOP_BUTTON_SELECTOR)).toEqual([]);
  expect(matches(form(false), CHATGPT_SEND_BUTTON_SELECTOR)).toEqual(["send"]);
});

test("conversation selectors recognize measured role-specific message structures", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument(`<body>
    <div data-content-search-unit-key="chat:assistant">
      <div data-markdown-text-style="assistant-message" id="assistant-message"></div>
      <div data-markdown-text-tone="assistant-message" id="wrong-assistant-attribute"></div>
    </div>
    <div data-content-search-unit-key="chat:user">
      <div data-user-message-bubble="true" id="user-message"></div>
      <div data-user-message-bubble="false" id="wrong-user-attribute"></div>
    </div>
  </body>`);
  const matches = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.id);
  expect(matches(CHATGPT_ASSISTANT_TURN_SELECTOR)).toEqual(["assistant-message"]);
  expect(matches(CHATGPT_USER_TURN_SELECTOR)).toEqual(["user-message"]);
});

test("effort activation binds the owned menu after the control opens", async () => {
  let opened = false;
  const ownedMenu = { isVisible: async () => opened };
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return opened ? "radix-effort-menu" : null;
      if (name === "aria-expanded") return opened ? "true" : "false";
      if (name === "data-state") return opened ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      expect(options).toEqual({ force: true, timeout: 1 });
      opened = true;
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[id="radix-effort-menu"]') return ownedMenu;
      return hiddenSurface;
    },
    keyboard: { press: async () => {} },
  };

  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("click");
  expect(activation.menu).toBe(ownedMenu as never);
});

test.each(["aria-expanded", "data-state"])("effort activation does not bind a closing menu (%s)", async attribute => {
  let opened = false;
  let clicks = 0;
  // Escape closes the control immediately, but the outgoing menu remains visible
  // through its exit animation. Its stale range must not authorize a new selection.
  const surface = {
    filter() { return this; }, last() { return this; }, locator() { return this; },
    isVisible: async () => true,
  };
  const control = {
    getAttribute: async (name: string) => name === attribute
      ? attribute === "aria-expanded" ? String(opened) : opened ? "open" : "closed"
      : null,
    click: async () => { clicks++; opened = true; },
  };
  const page = { locator: () => surface, keyboard: { press: async () => {} } };
  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("click");
  expect(clicks).toBe(1);
});

test("effort activation retries one ghost click with a primary pointerdown", async () => {
  let ghostOpen = false;
  let pointerOpened = false;
  const events: unknown[] = [];
  const ownedMenu = { isVisible: async () => pointerOpened };
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return pointerOpened ? "radix-effort-menu" : null;
      if (name === "aria-expanded") return ghostOpen ? "true" : "false";
      if (name === "data-state") return ghostOpen ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      events.push(["click", options]);
      ghostOpen = true;
    },
    dispatchEvent: async (name: string, detail: unknown) => {
      events.push([name, detail]);
      ghostOpen = true;
      pointerOpened = true;
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[id="radix-effort-menu"]') return ownedMenu;
      return hiddenSurface;
    },
    keyboard: {
      press: async (key: string) => {
        events.push(["keyboard", key]);
        ghostOpen = false;
      },
    },
  };

  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("pointerdown");
  expect(activation.menu).toBe(ownedMenu as never);
  expect(events).toEqual([
    ["click", { force: true, timeout: 1 }],
    ["keyboard", "Escape"],
    ["pointerdown", { button: 0, buttons: 1, pointerType: "mouse", isPrimary: true }],
  ]);
});

test("effort activation fails closed when neither event exposes a structural surface", async () => {
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async () => null,
    click: async () => {},
    dispatchEvent: async () => {},
  };
  const page = {
    locator: () => hiddenSurface,
    keyboard: { press: async () => {} },
  };

  await expect(activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 }))
    .rejects.toThrow("did not expose its owned menu or structural slider");
});

test("a complete authenticated composer with no effort selector is Luna-only", async () => {
  const effortButton = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => false,
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composer = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composer,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, extraHighAvailable: false, proAvailable: false });
});

test("a transient effort control does not turn a Luna-only account into Sol", async () => {
  let visibilityReads = 0;
  const effortButton = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => {
      visibilityReads += 1;
      return visibilityReads === 1;
    },
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composers = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composers,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, extraHighAvailable: false, proAvailable: false });
  expect(visibilityReads).toBe(2);
});

function reasoningPicker(options: { max?: string; delay?: number; missing?: boolean; loseSelectionOnClose?: boolean } = {}) {
  let value = 0;
  let opened = true;
  const keys: string[] = [];
  const hidden = {
    filter() { return this; }, last() { return this; }, getByText() { return this; },
    isVisible: async () => false,
    waitFor: ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  };
  const sliderControl = { press: async (key: string) => { keys.push(key); value += key === "ArrowRight" ? 1 : -1; } };
  const slider = {
    isVisible: async () => false, // Live DOM: aria-hidden=true, zero-width semantic span.
    filter: () => { throw new Error("Semantic input must not be visibility-filtered"); },
    waitFor: async ({ state }: { state: string }) => { expect(state).toBe("attached"); },
    getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": options.max ?? "4", "aria-valuenow": String(value), "aria-hidden": "true" })[name] ?? null,
    locator: () => sliderControl,
  };
  const container = {
    filter() { return this; }, last() { return this; },
    locator: () => slider,
    isVisible: async () => true,
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      if (options.missing) throw new Error("effort container never hydrated");
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    },
  };
  const control = {
    first() { return this; }, filter() { return this; }, last() { return this; },
    count: async () => 1, waitFor: async () => {}, isVisible: async () => true,
    click: async () => { opened = true; },
    innerText: async () => opened ? "Thinking effort" : ["Instant", "Medium", "High", "Extra High", "Pro"][value]!,
    getAttribute: async (name: string) => name === "aria-expanded" ? String(opened) : null,
  };
  const composer = { filter() { return this; }, last() { return this; }, isEditable: async () => true, locator: () => ({ locator: () => control }) };
  const modelRows = { count: async () => 3, first() { return this; }, waitFor: async () => {}, nth: () => { throw new Error("Model rows are not effort choices"); } };
  const menu = { filter() { return this; }, last() { return this; }, isVisible: async () => true, locator: () => modelRows };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composer;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return container;
      return hidden;
    },
    keyboard: { press: async () => {
      opened = false;
      if (options.loseSelectionOnClose) value = 0;
    } },
  };
  return { page, composer, keys, value: () => value };
}

test.each([0, 50])("capabilities wait for the visible container and read its hidden semantic input (delay=%s)", async delay => {
  const fixture = reasoningPicker({ delay });
  await expect(detectChatGptAccountCapabilities(fixture.page as never)).resolves.toEqual({
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: true,
  });
});

test("an absent effort slider cannot turn three model rows into a saved non-Pro capability", async () => {
  const fixture = reasoningPicker({ missing: true });
  await expect(detectChatGptAccountCapabilities(fixture.page as never)).rejects.toThrow("never hydrated");
});

test("the authoritative three-step range is non-Pro; a malformed range fails closed", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "2" }).page as never)).resolves.toEqual({
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  });
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "bad" }).page as never)).rejects.toThrow("model controls are unavailable");
});

test("a four-step effort range exposes Extra High without exposing Pro", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "3" }).page as never)).resolves.toEqual({
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: false,
  });
});

test("Pro selection verifies the persisted hidden slider through its visible owner, never model rows", async () => {
  for (const loseSelectionOnClose of [false, true]) {
    const fixture = reasoningPicker({ delay: 50, loseSelectionOnClose });
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      activeComposer: async () => fixture.composer,
    }) as { selectModelAndEffort(...args: unknown[]): Promise<{ selection: { label: string } }> };
    const selection = worker.selectModelAndEffort(fixture.page, "gpt-5.6-sol", "max", {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    });
    if (loseSelectionOnClose) await expect(selection).rejects.toMatchObject({ retryable: false });
    else expect((await selection).selection.label).toBe("Pro");
    expect(fixture.keys).toEqual(["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]);
    expect(fixture.value()).toBe(loseSelectionOnClose ? 0 : 4);
  }
});
