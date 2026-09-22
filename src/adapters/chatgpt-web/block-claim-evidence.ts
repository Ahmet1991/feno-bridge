/**
 * ChatGPT sometimes ends a turn by saying a tool call was blocked when no call was blocked, and
 * repeated instructions in AGENTS.md did not stop it. The bridge cannot know what a model intended,
 * but it does know exactly how many local tool calls a turn dispatched and how many returned an
 * error, so it states those two numbers next to the claim instead of arguing with it.
 *
 * The counts prove only what this bridge saw. A refusal upstream of the bridge never reaches the
 * broker at all, so "0 failed" is evidence that these calls succeeded, not proof that nothing was
 * ever refused. The wording keeps that distinction.
 */
// Missing a claim costs more than an extra informational line, so these lean broad. They cover the
// wordings observed on 19-20 Sep, including "güvenlik engeline takıldı", which no "engellendi"
// stem matches.
const BLOCK_CLAIM_PATTERNS: readonly RegExp[] = [
  /engellen/i,
  /engel\w*\s+tak[ıi]l/i,
  /g[üu]venlik\s+(?:kontrol|denetim|durum|engel)/i,
  /blocked\s+by\s+OpenAI/i,
  /safety\s+check/i,
  // "the tool is not here" is the same stop as "the tool was blocked": the model quits without
  // trying and blames the system. Measured on 22 Sep -- it said the local tools were not available
  // on a turn whose own request, as the bridge received it, declared exec_command, write_stdin,
  // apply_patch and view_image. A tool word has to appear near the phrase, so an answer that merely
  // reports something else being unavailable does not match.
  /(?:ara[cç]|tool|exec_command|write_stdin|apply_patch|view_image|tool_search)[^.\n]{0,80}(?:kullan[iı]labilir\s+(?:de[gğ]il|olarak\s+g[oö]r[uü]nm[uü]yor)|mevcut\s+de[gğ]il|eri[sş]ilemiyor)/i,
  /(?:tool|tools)[^.\n]{0,80}(?:not\s+available|unavailable|not\s+connected)/i,
];

/** The call that captures a window. An answer blaming a blocked screenshot is blaming this one. */
const WINDOW_CAPTURE = "get_window_state";

/** Reaching either of these means the turn really was working on a window. */
const WINDOW_SETUP = ["list_windows", "list_apps", "get_window", "activate_window"];

export function claimsBlockedToolCall(answer: string): boolean {
  return BLOCK_CLAIM_PATTERNS.some(pattern => pattern.test(answer));
}

/**
 * What this bridge dispatched for one logical turn.
 *
 * A Codex turn spans several adapter rounds: calls go out in one round and their results arrive in
 * the next. This is therefore kept for the lifetime of the turn's session. Counting per round made
 * the line report only the final round — on 20 Sep it said one call where the record showed two.
 */
export class TurnCallLedger {
  completed = 0;
  failed = 0;
  private readonly functions = new Set<string>();

  record(skyFunctions: readonly string[], isError: boolean): void {
    this.completed += 1;
    if (isError) this.failed += 1;
    for (const name of skyFunctions) this.functions.add(name);
  }

  /**
   * The only way to turn a ledger into evidence input. Passing the ledger itself would make the
   * flag truthy just because a method of that name exists, which a test caught.
   *
   * `windowCaptureNeverReached` means the turn set a window up and never asked to capture it. The
   * capture call may have been suppressed before it reached the bridge, so it reports reach, never
   * intent.
   */
  summary(): { completed: number; failed: number; windowCaptureNeverReached: boolean } {
    return {
      completed: this.completed,
      failed: this.failed,
      windowCaptureNeverReached:
        WINDOW_SETUP.some(name => this.functions.has(name)) && !this.functions.has(WINDOW_CAPTURE),
    };
  }
}

export function formatBlockClaimEvidence(
  counts: { completed: number; failed: number; windowCaptureNeverReached?: boolean },
): string {
  const { completed, failed } = counts;
  const observed = completed === 0
    ? "Bu turda köprü üzerinden hiç araç çağrısı yapılmadı."
    : `Bu turda ${completed} araç çağrısı tamamlandı, ${failed} tanesi hata döndürdü.`;
  const missing = counts.windowCaptureNeverReached
    ? ` Pencere hazırlandı ama ekran görüntüsü çağrısı (${WINDOW_CAPTURE}) köprüye hiç ulaşmadı.`
    : "";
  return `\n\n---\n[Feno Bridge] ${observed}${missing}`;
}

/** Returns the line to append, or undefined when the answer makes no such claim. */
export function blockClaimEvidenceFor(
  answer: string,
  counts: { completed: number; failed: number; windowCaptureNeverReached?: boolean },
): string | undefined {
  return claimsBlockedToolCall(answer) ? formatBlockClaimEvidence(counts) : undefined;
}
