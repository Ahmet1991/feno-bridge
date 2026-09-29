import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

turndown.use(gfm);
turndown.remove(["button", "script", "style"]);
// Turndown escapes both brackets, and Codex renders the `\[ … \]` pair that leaves behind (a plain
// "windows: []" on 28 Sep) as LaTeX. A `]` cannot open a link, image, reference or task box, so
// escaping `[` alone keeps all of those literal without ever writing the math delimiter pair. Every
// other `]` escape comes from this rule: source backslashes are doubled first.
const escapeMarkdownText = turndown.escape.bind(turndown);
turndown.escape = text => relaxOpeningBracketEscapes(escapeMarkdownText(text).replaceAll("\\]", "]"));

/**
 * 29.09: Turndown escapes every `[`, so a plain "[1, 2, 3]" reached Codex as "\[1, 2, 3]". An opening
 * bracket only needs its escape where Markdown could read syntax: a link or image (`](`), a
 * reference (`][`, `]:`), a footnote (`[^`), or a task box at the start of the text. Elsewhere the
 * bracket is literal either way, so its escape only changes the text Codex receives.
 */
function relaxOpeningBracketEscapes(escaped: string): string {
  let result = "";
  for (let index = 0; index < escaped.length; index += 1) {
    const char = escaped[index]!;
    if (char !== "\\" || escaped[index + 1] !== "[") {
      result += char;
      continue;
    }
    // Source backslashes arrive doubled, so this one escapes the bracket only when the run of
    // backslashes ending here is odd.
    let run = 0;
    for (let back = index; back >= 0 && escaped[back] === "\\"; back -= 1) run += 1;
    const close = escaped.indexOf("]", index + 2);
    const inside = close < 0 ? "" : escaped.slice(index + 2, close);
    // The next bracket may itself still carry its escape.
    const after = close < 0 ? "" : escaped.slice(close + 1, close + 3).replace(/^\\\[/, "[")[0] ?? "";
    const opensSyntax = close >= 0 && (
      after === "(" || after === "[" || after === ":" || inside.startsWith("^")
      || (/^\s*$/.test(result.replace(/\\\\/g, "")) && /^[ xX]$/.test(inside))
    );
    if (run % 2 === 1 && !opensSyntax && !inside.includes("\n")) {
      result += "[";
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}
turndown.addRule("tableCellLineBreak", {
  // Turndown writes <br> as a Markdown hard break, "  \n", which ends a GFM table row and spills the
  // rest of the cell out of the table (28 Sep: a four-commit git log cell broke the results table).
  // GFM keeps inline HTML inside a cell, and <br> is what ChatGPT's own Markdown had there.
  filter: node => node.nodeName === "BR" && insideTableCell(node),
  replacement: () => "<br>",
});
turndown.addRule("removeImages", {
  filter: node => ["IMG", "PICTURE", "SOURCE"].includes(node.nodeName),
  replacement: () => "",
});
turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});
turndown.addRule("preserveCodexPlanBlockTags", {
  filter: "p",
  replacement: content => {
    // Codex recognizes these standalone control lines verbatim. Restore only paragraph text:
    // a post-conversion replacement would also rewrite literal escapes in fenced code.
    const paragraph = content.replace(/^([ \t]*)<(\/?)proposed\\_plan>([ \t]*)$/gm, "$1<$2proposed_plan>$3");
    return `\n\n${paragraph}\n\n`;
  },
});
turndown.addRule("linkInlineFilePaths", {
  filter: node => inlineFilePath(node) !== undefined,
  replacement: (_content, node) => {
    const path = node.textContent!;
    const target = path.replaceAll("\\", "/");
    return `[${path}](<${target}>)`;
  },
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, "")
      .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? "\n" : ""}`;
  },
});

function insideTableCell(node: Node): boolean {
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (["TD", "TH"].includes(ancestor.nodeName)) return true;
    if (ancestor.nodeName === "TABLE") return false;
  }
  return false;
}

function inlineFilePath(node: Node): string | undefined {
  if (node.nodeName !== "CODE") return undefined;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (["A", "PRE"].includes(ancestor.nodeName)) return undefined;
  }

  const path = node.textContent ?? "";
  if (path !== path.trim() || /[\s`<>()[\]]/.test(path)) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return undefined;

  const withoutLocation = path.replace(/:\d+(?::\d+)?$/, "");
  const separator = Math.max(withoutLocation.lastIndexOf("/"), withoutLocation.lastIndexOf("\\"));
  if (separator < 0) return undefined;

  const basename = withoutLocation.slice(separator + 1);
  if (!/\.[a-z\d][a-z\d._-]*$/i.test(basename)) return undefined;
  return path;
}

function preserveObsidianWikiLinks(markdown: string): string {
  // Turndown escapes literal opening brackets, but Codex interprets the resulting `\[` as LaTeX.
  // Restore the source syntax before converting it into a regular Markdown file link.
  return markdown.replace(/\\\[\\\[([^\r\n]*?)\]\]/g, "[[$1]]");
}

function obsidianWikiLink(value: string): string | undefined {
  const separator = value.indexOf("|");
  const target = (separator >= 0 ? value.slice(0, separator) : value).trim();
  const label = (separator >= 0 ? value.slice(separator + 1) : value).trim();
  if (!target || !label || /[<>]/.test(target)) return undefined;

  const fragmentAt = target.indexOf("#");
  const note = fragmentAt >= 0 ? target.slice(0, fragmentAt) : target;
  const fragment = fragmentAt >= 0 ? target.slice(fragmentAt) : "";
  const extension = note.slice(note.lastIndexOf("/") + 1).includes(".");
  const path = note && !extension ? `${note}.md` : note;
  return `[${label}](<${path}${fragment}>)`;
}

function linkObsidianWikiLinks(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  return markdown.split("\n").map(line => {
    const fenceRun = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      const closingRun = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closingRun?.[0] === fence.marker && closingRun.length >= fence.length) fence = undefined;
      return line;
    }
    if (fenceRun) {
      fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
      return line;
    }

    let result = "";
    let inlineCodeTicks = 0;
    for (let index = 0; index < line.length;) {
      if (line[index] === "`") {
        let end = index + 1;
        while (line[end] === "`") end += 1;
        const ticks = end - index;
        inlineCodeTicks = inlineCodeTicks === 0 ? ticks : ticks === inlineCodeTicks ? 0 : inlineCodeTicks;
        result += line.slice(index, end);
        index = end;
        continue;
      }
      if (inlineCodeTicks === 0 && line.startsWith("[[", index) && line[index - 1] !== "!") {
        const end = line.indexOf("]]", index + 2);
        if (end >= 0) {
          const linked = obsidianWikiLink(line.slice(index + 2, end));
          if (linked) {
            result += linked;
            index = end + 2;
            continue;
          }
        }
      }
      result += line[index];
      index += 1;
    }
    return result;
  }).join("\n");
}

const OAI_MEMORY_CITATION_OPEN = "<oai-mem-citation>";
const OAI_MEMORY_CITATION_CLOSE = "</oai-mem-citation>";
const MARKDOWN_ESCAPED_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/;

function restoreCodexMemoryCitationEscapes(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let inCitation = false;

  return markdown.split("\n").map(line => {
    const fenceRun = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      const closingRun = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closingRun?.[0] === fence.marker && closingRun.length >= fence.length) fence = undefined;
      return line;
    }
    if (fenceRun) {
      fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
      return line;
    }

    let result = "";
    let inlineCodeTicks = 0;
    for (let index = 0; index < line.length;) {
      if (line[index] === "`") {
        let end = index + 1;
        while (line[end] === "`") end += 1;
        const ticks = end - index;
        inlineCodeTicks = inlineCodeTicks === 0 ? ticks : ticks === inlineCodeTicks ? 0 : inlineCodeTicks;
        result += line.slice(index, end);
        index = end;
        continue;
      }
      if (inlineCodeTicks === 0 && line.startsWith(OAI_MEMORY_CITATION_OPEN, index)) {
        inCitation = true;
        result += OAI_MEMORY_CITATION_OPEN;
        index += OAI_MEMORY_CITATION_OPEN.length;
        continue;
      }
      if (inlineCodeTicks === 0 && line.startsWith(OAI_MEMORY_CITATION_CLOSE, index)) {
        inCitation = false;
        result += OAI_MEMORY_CITATION_CLOSE;
        index += OAI_MEMORY_CITATION_CLOSE.length;
        continue;
      }
      if (inlineCodeTicks === 0 && inCitation && line[index] === "\\"
        && index + 1 < line.length && MARKDOWN_ESCAPED_PUNCTUATION.test(line[index + 1]!)) {
        result += line[index + 1];
        index += 2;
        continue;
      }
      result += line[index];
      index += 1;
    }
    return result;
  }).join("\n");
}

export function chatGptHtmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  return restoreCodexMemoryCitationEscapes(
    linkObsidianWikiLinks(preserveObsidianWikiLinks(turndown.turndown(html))),
  ).trim();
}

export interface ChatGptMarkdownSegment {
  key: string;
  tag?: string;
  html: string;
  text: string;
  group?: string;
  sourceStart?: number;
  sourceEnd?: number;
  streamable: boolean;
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number;
  streamableAt?: number;
}

interface CommittedChatGptMarkdownSegment {
  key: string;
  tag?: string;
  text: string;
  sourceStart?: number;
  sourceEnd?: number;
}

export class ChatGptMarkdownConsistencyError extends Error {
  constructor(message: string, readonly diagnostic?: {
    reason: "text_changed" | "block_order_changed" | "source_range_overlap";
    observedStart?: number;
    observedEnd?: number;
    committedStart?: number;
    committedEnd?: number;
    observedTextChars: number;
    committedTextChars: number;
    /** Turn-local ordinals, not proof that two DOM nodes have the same identity. */
    conflict?: "pending_before_committed" | "committed_order_reversed";
    observedOrdinal?: number;
    committedOrdinal?: number;
    previousMatchedCommittedOrdinal?: number;
    committedOrder?: number[];
    observedOrder?: (number | null)[];
    observedCountThroughConflict?: number;
    committedCount?: number;
    matchBasis?: "range" | "key" | "semantic";
    textEqual?: boolean;
    bufferFinishCompleted?: boolean;
  }) {
    super(message);
    this.name = "ChatGptMarkdownConsistencyError";
  }
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a character prefix is
 * not a safe commit boundary. It can also virtualize an already-rendered prefix, so later DOM
 * snapshots are partial observations rather than the response ledger. The browser supplies source
 * ranges for semantic blocks and marks a block streamable only after a following block exists.
 * Once committed, a missing prefix is harmless; changing text at a committed source range remains
 * an explicit protocol error because Responses deltas cannot be retracted.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<string, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;
  private consistencyError: ChatGptMarkdownConsistencyError | undefined;
  private finishCompleted = false;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
    /**
     * Whether an already-committed block is a promise to Codex. It is for an ordinary turn, whose
     * text Codex has consumed as it arrived; it is not for a turn the adapter opens for itself and
     * whose stream it suppresses, because nothing downstream has seen the earlier text.
     */
    private readonly committedBlocksAreContract = true,
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error("ChatGPT Markdown stability window must be a non-negative finite number");
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    const reconciled = this.reconcile(segments);
    if (reconciled instanceof ChatGptMarkdownConsistencyError) {
      // Measured on 22 Sep: the image delivery turn answered (659 characters are in the turn
      // record) and was then discarded because ChatGPT re-rendered a block it had already shown.
      // Nothing had been streamed to Codex, so the rewrite broke no promise -- it edited a draft
      // no one had read. Rebuilding from what is on screen keeps that answer.
      if (!this.committedBlocksAreContract) {
        this.resetCommittedHistory();
        // `reconcile` returns its input unchanged once nothing is committed, so this cannot recur.
        return this.observe(segments, now);
      }
      this.consistencyError = reconciled;
      return "";
    }
    this.consistencyError = undefined;
    this.latest = reconciled.map(segment => ({ ...segment }));

    const visibleCandidates = new Set<string>();
    for (const segment of reconciled) {
      const candidateId = this.candidateId(segment);
      visibleCandidates.add(candidateId);
      const previous = this.candidates.get(candidateId);
      const unchanged = previous
        && previous.key === segment.key
        && previous.tag === segment.tag
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group
        && previous.sourceStart === segment.sourceStart
        && previous.sourceEnd === segment.sourceEnd;
      this.candidates.set(candidateId, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      });
    }
    for (const candidateId of this.candidates.keys()) {
      if (!visibleCandidates.has(candidateId)) this.candidates.delete(candidateId);
    }

    let delta = "";
    let committedCount = 0;
    while (committedCount < reconciled.length) {
      const segment = reconciled[committedCount]!;
      const candidateId = this.candidateId(segment);
      const candidate = this.candidates.get(candidateId);
      if (!candidate?.streamable || candidate.streamableAt === undefined) break;
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
      delta += this.commit(candidate);
      this.committed.push(this.committedSegment(candidate));
      this.candidates.delete(candidateId);
      committedCount += 1;
    }
    this.latest = this.latest.slice(committedCount);
    return delta;
  }

  finish(): { markdown: string; delta: string } {
    if (this.consistencyError) throw this.consistencyError;
    let delta = "";
    for (const segment of this.latest) {
      delta += this.commit(segment);
      this.committed.push(this.committedSegment(segment));
    }
    this.candidates.clear();
    this.latest = [];
    this.finishCompleted = true;
    return { markdown: this.markdown, delta };
  }

  currentSnapshotIsConsistent(): boolean {
    return this.consistencyError === undefined;
  }

  /** Forgets what was committed so the next observation rebuilds the answer from scratch. */
  private resetCommittedHistory(): void {
    this.committed.length = 0;
    this.candidates.clear();
    this.latest = [];
    this.markdown = "";
    this.lastGroup = undefined;
    this.consistencyError = undefined;
    this.finishCompleted = false;
  }

  private reconcile(
    segments: ChatGptMarkdownSegment[],
  ): ChatGptMarkdownSegment[] | ChatGptMarkdownConsistencyError {
    if (this.committed.length === 0 || segments.length === 0) return segments;

    const pending: ChatGptMarkdownSegment[] = [];
    const lastRangedCommitted = this.committed
      .filter(segment => segment.sourceEnd !== undefined)
      .at(-1);
    const lastCommittedEnd = lastRangedCommitted?.sourceEnd;
    let highestCommittedIndex = -1;
    let sawPending = false;
    let previousSourceStart: number | undefined;
    const observedOrder: (number | null)[] = [];

    for (const [observedOrdinal, segment] of segments.entries()) {
      if (segment.sourceStart !== undefined) {
        if (previousSourceStart !== undefined && segment.sourceStart <= previousSourceStart) {
          return new ChatGptMarkdownConsistencyError(
            "ChatGPT final DOM exposed non-monotonic source ranges",
          );
        }
        previousSourceStart = segment.sourceStart;
      }
      const committedIndex = this.committedIndex(segment);
      if (committedIndex !== undefined) {
        const committed = this.committed[committedIndex]!;
        observedOrder.push(committedIndex);
        if (observedOrder.length > 8) observedOrder.shift();
        if (sawPending || committedIndex < highestCommittedIndex || committed.text !== segment.text) {
          return this.changedCommittedBlockError(
            sawPending || committedIndex < highestCommittedIndex ? "block_order_changed" : "text_changed",
            segment,
            committed,
            sawPending || committedIndex < highestCommittedIndex ? {
              conflict: sawPending ? "pending_before_committed" : "committed_order_reversed",
              observedOrdinal,
              committedOrdinal: committedIndex,
              previousMatchedCommittedOrdinal: highestCommittedIndex,
              committedOrder: Array.from(
                { length: Math.min(8, this.committed.length) },
                (_, index) => this.committed.length - Math.min(8, this.committed.length) + index,
              ),
              observedOrder: [...observedOrder],
              observedCountThroughConflict: observedOrdinal + 1,
              committedCount: this.committed.length,
              matchBasis: segment.sourceStart !== undefined && committed.sourceStart !== undefined
                ? "range"
                : segment.key === committed.key ? "key" : "semantic",
              textEqual: committed.text === segment.text,
              bufferFinishCompleted: this.finishCompleted,
            } : undefined,
          );
        }
        highestCommittedIndex = committedIndex;
        continue;
      }

      observedOrder.push(null);
      if (observedOrder.length > 8) observedOrder.shift();
      if (segment.sourceStart !== undefined && lastCommittedEnd !== undefined) {
        if (segment.sourceStart <= lastCommittedEnd) {
          return this.changedCommittedBlockError("source_range_overlap", segment, lastRangedCommitted!);
        }
        sawPending = true;
        pending.push(segment);
        continue;
      }

      const followsVisibleCommittedTail = highestCommittedIndex === this.committed.length - 1;
      if (!followsVisibleCommittedTail && !this.matchesLatestPending(segment)) {
        return new ChatGptMarkdownConsistencyError(
          "ChatGPT final DOM could not be aligned with text already streamed to Codex",
        );
      }
      sawPending = true;
      pending.push(segment);
    }

    return pending;
  }

  private committedIndex(segment: ChatGptMarkdownSegment): number | undefined {
    const exact = this.committed.findIndex(committed => (
      segment.sourceStart !== undefined && committed.sourceStart !== undefined
        ? segment.sourceStart === committed.sourceStart && segment.tag === committed.tag
        : segment.key === committed.key
    ));
    if (exact >= 0) return exact;

    if (segment.sourceStart !== undefined) return undefined;
    if (!segment.tag) return undefined;
    const semanticMatches = this.committed
      .map((committed, index) => ({ committed, index }))
      .filter(({ committed }) => committed.tag === segment.tag && committed.text === segment.text);
    return semanticMatches.length === 1 ? semanticMatches[0]!.index : undefined;
  }

  private matchesLatestPending(segment: ChatGptMarkdownSegment): boolean {
    const exact = this.latest.filter(candidate => (
      segment.sourceStart !== undefined && candidate.sourceStart !== undefined
        ? segment.sourceStart === candidate.sourceStart && segment.tag === candidate.tag
        : segment.key === candidate.key
    ));
    if (exact.length === 1) return true;
    if (segment.sourceStart !== undefined) return false;
    if (!segment.tag) return false;
    return this.latest.filter(candidate => (
      candidate.tag === segment.tag && candidate.text === segment.text
    )).length === 1;
  }

  private candidateId(segment: ChatGptMarkdownSegment): string {
    return segment.sourceStart !== undefined
      ? `source:${segment.sourceStart}:${segment.tag ?? ""}`
      : `key:${segment.key}`;
  }

  private committedSegment(segment: ChatGptMarkdownSegment): CommittedChatGptMarkdownSegment {
    return {
      key: segment.key,
      ...(segment.tag ? { tag: segment.tag } : {}),
      text: segment.text,
      ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
      ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
    };
  }

  private changedCommittedBlockError(
    reason: NonNullable<ChatGptMarkdownConsistencyError["diagnostic"]>["reason"],
    observed: ChatGptMarkdownSegment,
    committed: CommittedChatGptMarkdownSegment,
    orderDiagnostic?: Pick<NonNullable<ChatGptMarkdownConsistencyError["diagnostic"]>,
      "conflict" | "observedOrdinal" | "committedOrdinal" | "previousMatchedCommittedOrdinal"
      | "committedOrder" | "observedOrder" | "observedCountThroughConflict" | "committedCount"
      | "matchBasis" | "textEqual" | "bufferFinishCompleted">,
  ): ChatGptMarkdownConsistencyError {
    return new ChatGptMarkdownConsistencyError(
      "ChatGPT changed a completed text block that was already streamed to Codex",
      {
        reason,
        observedStart: observed.sourceStart,
        observedEnd: observed.sourceEnd,
        committedStart: committed.sourceStart,
        committedEnd: committed.sourceEnd,
        observedTextChars: observed.text.length,
        committedTextChars: committed.text.length,
        ...orderDiagnostic,
      },
    );
  }

  private commit(segment: ChatGptMarkdownSegment): string {
    const block = this.transform(chatGptHtmlToMarkdown(segment.html));
    if (!block) return "";
    const separator = this.markdown
      ? segment.group !== undefined && segment.group === this.lastGroup ? "\n" : "\n\n"
      : "";
    const delta = `${separator}${block}`;
    this.markdown += delta;
    this.lastGroup = segment.group;
    return delta;
  }
}
