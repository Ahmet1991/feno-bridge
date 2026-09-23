import { expect, test } from "bun:test";
import {
  ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError, chatGptHtmlToMarkdown, type ChatGptMarkdownSegment,
} from "../src/adapters/chatgpt-web/markdown";

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    expect(chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`))
      .toBe(`Created [${path}](<${target}>).`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("converts Obsidian aliases and headings but preserves code examples and embeds", () => {
  const html = [
    "<p>Open [[Notes/weekly-review|review]] and [[Projects/sample#Status]].</p>",
    "<p>Keep <code>[[wiki/example]]</code> and ![[image.png]] literal.</p>",
    "<pre><code>\`\`\`not a closing fence\n[[wiki/fenced]]</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Open [review](<Notes/weekly-review.md>) and [Projects/sample#Status](<Projects/sample.md#Status>).",
    "",
    "Keep `[[wiki/example]]` and ![[image.png]] literal.",
    "",
    "````",
    "```not a closing fence",
    "[[wiki/fenced]]",
    "````",
  ].join("\n"));
});


function segment(key: string, text: string, sourceStart: number): ChatGptMarkdownSegment {
  return {
    key, tag: "p", html: `<p>${text}</p>`, text, streamable: true,
    sourceStart, sourceEnd: sourceStart + text.length,
  };
}

test("a rewritten block ends an ordinary turn, because Codex already read the first version", () => {
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe([segment("a", "first", 0)], 0);
  expect(buffer.finish().markdown).toBe("first");
  // Codex consumed "first" as it streamed, so ChatGPT replacing it is a broken promise, not an edit.
  buffer.observe([segment("a", "rewritten", 0)], 1);
  expect(buffer.currentSnapshotIsConsistent()).toBeFalse();
  try {
    buffer.finish();
    throw new Error("expected the completed block rewrite to fail");
  } catch (error) {
    expect((error as ChatGptMarkdownConsistencyError).message).toContain("changed a completed text block");
    expect((error as ChatGptMarkdownConsistencyError).diagnostic?.reason).toBe("text_changed");
  }
});

test("a rewritten block is absorbed when the answer never streamed to Codex", () => {
  // The live failure this exists for: on 22 Sep the image delivery turn produced a 659-character
  // answer that the bridge threw away because ChatGPT re-rendered a block. That turn suppresses its
  // own stream and appends the finished answer, so nothing downstream had read the earlier text.
  const buffer = new ChatGptMarkdownBuffer(undefined, undefined, false);
  buffer.observe([segment("a", "first", 0)], 0);
  expect(buffer.finish().markdown).toBe("first");
  buffer.observe([segment("a", "rewritten", 0)], 1);
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish().markdown).toBe("rewritten");
});

test("absorbing a rewrite keeps the rest of the answer, not just the block that changed", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, undefined, false);
  buffer.observe([segment("a", "opening", 0), segment("b", "middle", 20)], 0);
  expect(buffer.finish().markdown).toBe("opening\n\nmiddle");
  buffer.observe([segment("a", "opening", 0), segment("b", "edited", 20), segment("c", "closing", 40)], 1);
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish().markdown).toBe("opening\n\nedited\n\nclosing");
});

test("diagnostic distinguishes pending-before-committed from a committed-order reversal without text", () => {
  const bare = (key: string, text: string, streamable = true): ChatGptMarkdownSegment => ({
    key, tag: "p", html: `<p>${text}</p>`, text, streamable,
  });
  const pending = new ChatGptMarkdownBuffer(undefined, 0);
  pending.observe([bare("a", "PRIVATE_A"), bare("x", "PRIVATE_X", false)], 0);
  pending.observe([bare("a", "PRIVATE_A"), bare("x", "PRIVATE_X", false), bare("a", "PRIVATE_A")], 1);
  expect(() => pending.finish()).toThrow(ChatGptMarkdownConsistencyError);
  const pendingDiagnostic = (() => { try { pending.finish(); } catch (error) {
    return (error as ChatGptMarkdownConsistencyError).diagnostic;
  } })();
  expect(pendingDiagnostic).toMatchObject({
    reason: "block_order_changed", conflict: "pending_before_committed",
    observedOrdinal: 2, committedOrdinal: 0, previousMatchedCommittedOrdinal: 0,
    committedOrder: [0], observedOrder: [0, null, 0], textEqual: true,
    matchBasis: "key", bufferFinishCompleted: false,
  });
  expect(JSON.stringify(pendingDiagnostic)).not.toContain("PRIVATE_");

  const reversed = new ChatGptMarkdownBuffer(undefined, 0);
  reversed.observe([bare("a", "PRIVATE_A"), bare("b", "PRIVATE_B")], 0);
  reversed.observe([bare("b", "PRIVATE_B"), bare("a", "PRIVATE_A")], 1);
  const reversedDiagnostic = (() => { try { reversed.finish(); } catch (error) {
    return (error as ChatGptMarkdownConsistencyError).diagnostic;
  } })();
  expect(reversedDiagnostic).toMatchObject({
    reason: "block_order_changed", conflict: "committed_order_reversed",
    observedOrdinal: 1, committedOrdinal: 0, previousMatchedCommittedOrdinal: 1,
    committedOrder: [0, 1], observedOrder: [1, 0], textEqual: true,
    matchBasis: "key", bufferFinishCompleted: false,
  });
  expect(JSON.stringify(reversedDiagnostic)).not.toContain("PRIVATE_");

  const bounded = new ChatGptMarkdownBuffer(undefined, 0);
  bounded.observe(Array.from({ length: 12 }, (_, index) => bare(String(index), `PRIVATE_${index}`)), 0);
  bounded.observe([bare("11", "PRIVATE_11"), bare("10", "PRIVATE_10")], 1);
  const boundedDiagnostic = (() => { try { bounded.finish(); } catch (error) {
    return (error as ChatGptMarkdownConsistencyError).diagnostic;
  } })();
  expect(boundedDiagnostic?.committedOrder).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  expect(boundedDiagnostic?.observedOrder).toEqual([11, 10]);
  expect(JSON.stringify(boundedDiagnostic)).not.toContain("PRIVATE_");
});
