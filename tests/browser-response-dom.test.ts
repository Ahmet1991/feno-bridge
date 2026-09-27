import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { Locator } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, CHATGPT_COMPLETION_SETTLE_MS } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

const smokeHtml = readFileSync(new URL("./fixtures/chatgpt-dil-smoke.html", import.meta.url), "utf8");
type Snapshot = {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  traceBlocks: { kind: string; text: string }[];
};

// Execute the production page callback, with only missing Domino browser APIs supplied.
async function snapshot(html: string): Promise<Snapshot> {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(html);
  const innerText = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText");
  const append = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "append");
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true, get() { return this.textContent; },
  });
  Object.defineProperty(window.HTMLElement.prototype, "append", {
    configurable: true, value(this: HTMLElement, ...nodes: Node[]) { nodes.forEach(node => this.appendChild(node)); },
  });
  const collections = [window.document.querySelectorAll("div"), window.document.body.children].map(Object.getPrototypeOf);
  const iterators = collections.map(prototype => Object.getOwnPropertyDescriptor(prototype, Symbol.iterator));
  for (const prototype of collections) Object.defineProperty(prototype, Symbol.iterator, {
    configurable: true, value: Array.prototype[Symbol.iterator],
  });
  try {
    const context = createContext({
      document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
      Node: window.Node, NodeFilter: window.NodeFilter, performance: { timeOrigin: 1 },
      getComputedStyle: (element: HTMLElement) => ({
        display: element.style.display || "block", visibility: "visible", opacity: "1",
      }),
      MutationObserver: class { observe() {} },
    });
    const errors: unknown[] = [];
    const locator = {
      evaluate: async (callback: Function, options: unknown) => {
        try { return runInContext(`(${callback.toString()})`, context)(window.document.getElementById("turn"), options); }
        catch (error) { errors.push(error); throw error; }
      },
      page: () => ({ isClosed: () => false }),
    } as unknown as Locator;
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      responseDomSnapshot(locator: Locator): Promise<Snapshot>;
    };
    const result = await worker.responseDomSnapshot(locator);
    expect(errors).toEqual([]);
    return result;
  } finally {
    collections.forEach((prototype, index) => {
      if (iterators[index]) Object.defineProperty(prototype, Symbol.iterator, iterators[index]!);
      else delete prototype[Symbol.iterator];
    });
    if (innerText) Object.defineProperty(window.HTMLElement.prototype, "innerText", innerText);
    else delete window.HTMLElement.prototype.innerText;
    if (append) Object.defineProperty(window.HTMLElement.prototype, "append", append);
    else delete window.HTMLElement.prototype.append;
  }
}

test("captured DIL smoke response reaches Markdown delivery and stable completion", async () => {
  // Also cover a changed CSS module hash and nested Markdown without duplicate delivery.
  for (const html of [
    smokeHtml,
    smokeHtml.replaceAll("fv0XaG_", "changed_"),
    smokeHtml.replace('<p class="w6asjq_TextBase _85PZeG_Text">', '<p class="markdown">'),
    '<section id="turn"><div class="markdown"><p>CODEX WEB GPT READY</p></div><button data-testid="copy-turn-action-button"></button></section>',
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("CODEX WEB GPT READY");
    expect(response.completionActionVisible).toBeTrue();
    const buffer = new ChatGptMarkdownBuffer();
    buffer.observe(response.markdownSegments, 0);
    expect(buffer.finish().markdown).toBe("CODEX WEB GPT READY");
    const tracker = new ChatGptCompletionTracker();
    const state = { ...response, running: false, currentText: response.visibleText, currentHtml: response.fullHtml };
    expect(tracker.update({ ...state, running: true }, 0)).toBeFalse();
    expect(tracker.update(state, 1)).toBeFalse();
    expect(tracker.update(state, 1 + CHATGPT_COMPLETION_SETTLE_MS)).toBeTrue();
    expect(response.traceBlocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "answer", text: "CODEX WEB GPT READY" },
    ]);
  }
});

test("reported code-block containers preserve code while their localized toolbar changes", async () => {
  const code = '  first = "kod"\n\n  print(first)\n  # ```\n';
  for (const block of ["div", "pre"]) {
    for (const label of ["Düz metin", "Plain text", "Code"]) {
      const html = (toolbar: string, value = code) => `<section id="turn"><div class="markdown">
          <p data-start="0" data-end="10">Example</p>
          <div data-start="12" data-end="100"><${block} data-markdown-copy="code-block">
            ${toolbar}<div><code class="language-python whitespace-pre block"><span>${value}</span></code></div>
          </${block}></div>
          <p data-start="102" data-end="120">Done.</p>
        </div></section>`;
      const during = await snapshot(html(`<div>${label}<button>Copy</button></div>`));
      const after = await snapshot(html(""));
      expect(during.markdownSegments.some(segment => segment.text.includes(label))).toBeFalse();
      expect(during.markdownSegments.map(segment => segment.html).join("\n")).toContain("<pre");
      expect(after.markdownSegments.map(segment => segment.html).join("\n")).toContain("<pre");
      const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
      buffer.observe(during.markdownSegments, 0);
      buffer.observe(after.markdownSegments, 1000);
      expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
      expect(buffer.finish().markdown).toBe(`Example\n\n\`\`\`python\n${code}\`\`\`\n\nDone.`);

      const changed = await snapshot(html("", code.replace("print(first)", "print(other)")));
      buffer.observe(changed.markdownSegments, 2000);
      expect(() => buffer.finish()).toThrow("ChatGPT changed a completed text block");
    }
  }
});

test("ordinary prose, inline code and legacy fenced code keep their meaning", async () => {
  const response = await snapshot(`<section id="turn" data-turn="assistant">
    <div data-message-author-role="assistant"><div class="markdown">
      <p>Code: <code>/tmp/file.ts</code></p>
      <pre data-start="30" data-end="80"><code class="language-text">/tmp/file.ts\n\n[[note]]\n\`\`\`\nend</code></pre>
      <p>Done.</p>
    </div></div></section>`);
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(response.markdownSegments, 0);
  expect(buffer.finish().markdown).toBe("Code: [/tmp/file.ts](</tmp/file.ts>)\n\n````text\n/tmp/file.ts\n\n[[note]]\n```\nend\n````\n\nDone.");
});

test("DIL response extraction preserves ownership, commentary and completion boundaries", async () => {
  for (const html of [
    smokeHtml.replace('data-message-author-role="assistant"', 'data-message-author-role="user"'),
    smokeHtml.replace("fv0XaG_DilResponseRoot", "unrelated-widget"),
    smokeHtml.replace('dir="auto"', 'dir="auto" style="display:none"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-streaming-response-status="thinking"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-testid="cot-v5"'),
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("");
    expect(response.completionActionVisible).toBeFalse();
  }
  const noCopy = await snapshot(smokeHtml.replace('data-testid="copy-turn-action-button"', 'data-testid="other-action"'));
  expect(noCopy.visibleText).toBe("CODEX WEB GPT READY");
  expect(noCopy.completionActionVisible).toBeFalse();
});

test("unit-key assistant extraction reads the entire outer turn across streaming bodies", async () => {
  const response = await snapshot(
    '<section id="turn" data-content-search-unit-key="fallback-turn-0:2:assistant">'
      + '<div data-markdown-text-style="assistant-message"><p>First part. </p></div>'
      + '<div data-markdown-text-style="assistant-message"><p>Second part. </p></div>'
      + '<div data-markdown-text-style="assistant-message"><p>Third part.</p></div>'
      + '</section>',
  );
  expect(response.responsePresent).toBeTrue();
  expect(response.visibleText).toBe("First part. Second part. Third part.");
  expect(response.fullHtml).toContain("Third part.");
  expect(response.markdownSegments.length).toBeGreaterThan(0);
});
