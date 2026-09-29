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

test("preserves standalone Codex plan markers in paragraphs and list continuations", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>&lt;proposed_plan&gt;</p>",
    "<h2>Plan</h2>",
    "<ul><li><p>Keep snake_case.</p><p>&lt;/proposed_plan&gt;</p></li></ul>",
  ].join(""))).toBe([
    "<proposed_plan>", "", "## Plan", "", "- Keep snake\\_case.", "  ", "  </proposed_plan>",
  ].join("\n"));
  expect(chatGptHtmlToMarkdown("<p>&lt;proposed_plan&gt;<br>Step<br>&lt;/proposed_plan&gt;</p>"))
    .toBe("<proposed_plan>  \nStep  \n</proposed_plan>");
});

test("preserving plan markers does not rewrite mentions or literal code", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>Mention &lt;proposed_plan&gt; and &lt;/proposed_plan&gt; inline.</p>",
    "<p><code>&lt;proposed_plan&gt;</code> <code>&lt;/proposed_plan&gt;</code></p>",
    "<pre><code>&lt;proposed\\_plan&gt;\n&lt;/proposed\\_plan&gt;</code></pre>",
  ].join(""))).toBe([
    "Mention <proposed\\_plan> and </proposed\\_plan> inline.", "",
    "`<proposed_plan>` `</proposed_plan>`", "",
    "```", "<proposed\\_plan>", "</proposed\\_plan>", "```",
  ].join("\n"));
});

test("restores Markdown escapes inside the observed Codex memory citation block", () => {
  const observedBroken = String.raw`<oai-mem-citation> <citation\_entries> MEMORY.md:748-748|note=\[Windows Computer Use route and observe act verify workflow\] </citation\_entries> <rollout\_ids> 01a0c8cc-8e2c-7172-9345-60146e6d1ce9 </rollout\_ids> </oai-mem-citation>`;
  const sourceText = observedBroken
    .replaceAll(String.raw`\_`, "_")
    .replaceAll(String.raw`\[`, "[")
    .replaceAll(String.raw`\]`, "]");
  const source = `<p>${sourceText.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`;
  expect(chatGptHtmlToMarkdown(source)).toBe(
    "<oai-mem-citation> <citation_entries> MEMORY.md:748-748|note=[Windows Computer Use route and observe act verify workflow] </citation_entries> <rollout_ids> 01a0c8cc-8e2c-7172-9345-60146e6d1ce9 </rollout_ids> </oai-mem-citation>",
  );
});

test("memory citation restoration leaves inline and fenced code untouched", () => {
  expect(chatGptHtmlToMarkdown([
    "<p><code>&lt;oai-mem-citation&gt; &lt;citation\\_entries&gt; \\[x\\] &lt;/citation\\_entries&gt; &lt;/oai-mem-citation&gt;</code></p>",
    "<pre><code>&lt;oai-mem-citation&gt;\n&lt;citation\\_entries&gt; \\[x\\] &lt;/citation\\_entries&gt;\n&lt;/oai-mem-citation&gt;</code></pre>",
  ].join(""))).toBe([
    "`<oai-mem-citation> <citation\\_entries> \\[x\\] </citation\\_entries> </oai-mem-citation>`", "",
    "```", "<oai-mem-citation>", "<citation\\_entries> \\[x\\] </citation\\_entries>", "</oai-mem-citation>", "```",
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

test("keeps a cell's line breaks inside its table row", () => {
  // 28 Sep: a four-commit git log cell was written as hard breaks, which ended the row early.
  const html = "<table><thead><tr><th>Test</th><th>Kanıt</th></tr></thead><tbody>"
    + "<tr><td>6</td><td>e3a5b20 feno<br>66aebe7 feno</td></tr>"
    + "<tr><td>7</td><td>tamam</td></tr></tbody></table>";
  expect(chatGptHtmlToMarkdown(html)).toBe([
    "| Test | Kanıt |",
    "| --- | --- |",
    "| 6 | e3a5b20 feno<br>66aebe7 feno |",
    "| 7 | tamam |",
  ].join("\n"));
  // Outside a table a line break is still a Markdown hard break.
  expect(chatGptHtmlToMarkdown("<p>bir<br>iki</p>")).toBe("bir  \niki");
});

test("never writes the \\[ … \\] pair that Codex renders as LaTeX", () => {
  // 28 Sep: "windows: []" reached Codex as "windows: \\[\\]" and rendered as an empty formula.
  // 29.09: a bracket that cannot open syntax keeps no escape at all ("[1, 2, 3]" arrived as "\[1, 2, 3]").
  expect(chatGptHtmlToMarkdown("<p>windows: [] ile doğrulandı</p>")).toBe("windows: [] ile doğrulandı");
  expect(chatGptHtmlToMarkdown("<p>[1, 2, 3]</p>")).toBe("[1, 2, 3]");
  expect(chatGptHtmlToMarkdown("<p>[metin](adres) ve [x] kutu</p>")).toBe(String.raw`\[metin](adres) ve [x] kutu`);
  // Where it could open syntax, the opening escape still keeps it literal: a link, a reference,
  // a footnote, and a task box at the start of a list item.
  expect(chatGptHtmlToMarkdown("<p>[a][b] ve [c]: tanım ve [^1]</p>")).toBe("\\[a][b] ve \\[c]: tanım ve \\[^1]");
  expect(chatGptHtmlToMarkdown("<ul><li>[ ] yapılacak</li><li>[x] bitti</li></ul>")).toBe("- \\[ ] yapılacak\n- \\[x] bitti");
  // A source backslash before a bracket stays a literal backslash.
  expect(chatGptHtmlToMarkdown(String.raw`<p>dosya \[1] son</p>`)).toBe(String.raw`dosya \\[1] son`);
  // A source backslash before a bracket survives as text.
  expect(chatGptHtmlToMarkdown(String.raw`<p>yol C:\a] son</p>`)).toBe(String.raw`yol C:\\a] son`);
  for (const html of ["<p>[a] ve [b]</p>", "<p>dizi [1, 2] ve [3]</p>", "<ul><li>[ ] yapılacak</li></ul>"]) {
    expect(chatGptHtmlToMarkdown(html)).not.toMatch(/\\\[[^\n]*\\\]/);
  }
});
