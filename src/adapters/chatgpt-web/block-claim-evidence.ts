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
];

export function claimsBlockedToolCall(answer: string): boolean {
  return BLOCK_CLAIM_PATTERNS.some(pattern => pattern.test(answer));
}

export function formatBlockClaimEvidence(counts: { completed: number; failed: number }): string {
  const { completed, failed } = counts;
  const observed = completed === 0
    ? "Bu turda köprü üzerinden hiç araç çağrısı yapılmadı."
    : `Bu turda ${completed} araç çağrısı tamamlandı, ${failed} tanesi hata döndürdü.`;
  return `\n\n---\n[Feno Bridge] ${observed}`;
}

/** Returns the line to append, or undefined when the answer makes no such claim. */
export function blockClaimEvidenceFor(
  answer: string,
  counts: { completed: number; failed: number },
): string | undefined {
  return claimsBlockedToolCall(answer) ? formatBlockClaimEvidence(counts) : undefined;
}
