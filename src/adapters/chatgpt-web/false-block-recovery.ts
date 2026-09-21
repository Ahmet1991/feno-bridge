/**
 * A turn sometimes ends with the model reporting that a tool call was blocked when the record shows
 * no such thing: on 21 Sep one session made four successful `cua` calls and then quoted an OpenAI
 * block message that appears in no tool output, and another produced the same message having made
 * no call at all. `block-claim-evidence.ts` already states what the bridge counted; this adds the
 * one thing that measurably changes the outcome.
 *
 * Measured, not assumed. Replying to such a turn with the correction below returned:
 * "Haklısın. Önceki cevabımda bir araç çıktısına dayanmayan bir hata metni aktardım; bunu
 * doğrulanmış bir araç sonucu gibi sunmam doğru değildi." — the claim was withdrawn and the real
 * reason given. That measurement is why the correction is worded exactly this way.
 */

/**
 * The correction never tells the model to go ahead, because some stops are right. The session that
 * produced the four-call claim was about to submit a number-portability application carrying
 * someone's identity details; stopping there was correct and only the invented error was wrong.
 * Pushing a model past a refusal it meant is worse than the fabrication this repairs, so the text
 * corrects the record and leaves the decision alone.
 */
export function falseBlockCorrection(counts: { completed: number; failed: number }): string {
  const observed = counts.completed === 0
    // The bridge cannot see a refusal that never reached it, so this says what it observed rather
    // than claiming nothing refused the call.
    ? "bu turda köprüye hiçbir araç çağrısı ulaşmadı"
    : `bu turda ${counts.completed} araç çağrısı tamamlandı ve hiçbiri hata döndürmedi`;
  return `Kayda göre ${observed}, ve bildirdiğin engel metni hiçbir araç çıktısından gelmedi.`
    + " Devam edebiliyorsan devam et."
    + " Devam etmemeyi seçiyorsan gerekçeni kendi sözlerinle söyle;"
    + " olmayan bir sistem hatasını gerekçe gösterme.";
}

/**
 * Only a claim the bridge can contradict is worth a second turn.
 *
 * `failed > 0` is excluded because a tool really did return an error and the answer may be
 * reporting it. `completed === 0` is included: the bridge cannot prove nothing refused the call
 * upstream, but the correction above never asserts that — it reports what reached the bridge, and
 * that is the exact case the measurement above was taken in.
 */
export function shouldRecoverFalseBlockClaim(
  claimsBlock: boolean,
  counts: { completed: number; failed: number },
): boolean {
  return claimsBlock && counts.failed === 0;
}
