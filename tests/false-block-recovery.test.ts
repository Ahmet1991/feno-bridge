import { expect, test } from "bun:test";
import { claimsBlockedToolCall } from "../src/adapters/chatgpt-web/block-claim-evidence";
import { falseBlockCorrection, shouldRecoverFalseBlockClaim } from "../src/adapters/chatgpt-web/false-block-recovery";

const claim = (answer: string) => claimsBlockedToolCall(answer);

// The two live answers this repairs, quoted from the 21 Sep records.
const FOUR_CALL_CLAIM = "Tarifeler ekranına geçiş için tıklama aşamasında araç çağrısı güvenlik"
  + " nedeniyle durduruldu: Bu araç çağrısı, isteğin güvenlik durumunu belirleyemediğimiz için"
  + " OpenAI tarafından engellendi.";
const NO_CALL_CLAIM = "Bu araç OpenAI'ın güvenlik kontrolleri tarafından engellendi.";

test("a block claim the ledger contradicts is corrected", () => {
  expect(shouldRecoverFalseBlockClaim(claim(FOUR_CALL_CLAIM), { completed: 4, failed: 0 })).toBeTrue();
});

test("a claim is corrected even when nothing reached the bridge, because the wording only reports that", () => {
  // The measurement that justifies this branch was taken in exactly this case: no call and no tool
  // search was recorded, and the correction still produced a withdrawal rather than a repeat.
  expect(shouldRecoverFalseBlockClaim(claim(NO_CALL_CLAIM), { completed: 0, failed: 0 })).toBeTrue();
  expect(falseBlockCorrection({ completed: 0, failed: 0 }))
    .toContain("köprüye hiçbir araç çağrısı ulaşmadı");
  // It must never claim nothing refused the call, which the bridge cannot see.
  expect(falseBlockCorrection({ completed: 0, failed: 0 })).not.toContain("engellenmedin");
});

test("a real tool error is never contradicted", () => {
  expect(shouldRecoverFalseBlockClaim(claim(FOUR_CALL_CLAIM), { completed: 4, failed: 1 })).toBeFalse();
  expect(shouldRecoverFalseBlockClaim(claim(NO_CALL_CLAIM), { completed: 0, failed: 2 })).toBeFalse();
});

test("an answer that claims nothing is left alone", () => {
  expect(shouldRecoverFalseBlockClaim(claim("Ekran görüntüsünü aldım, başlık: Feno Bridge."), { completed: 2, failed: 0 }))
    .toBeFalse();
});

test("the correction states the record and never pushes the model to act", () => {
  const text = falseBlockCorrection({ completed: 4, failed: 0 });
  expect(text).toContain("4 araç çağrısı tamamlandı");
  expect(text).toContain("hiçbir araç çıktısından gelmedi");
  // Leaving the decision alone is the point: the session that produced the four-call claim was
  // about to submit someone's identity details, where stopping was the right call and only the
  // invented error was wrong. A correction that pushed would be worse than the fabrication.
  expect(text).toContain("gerekçeni kendi sözlerinle söyle");
  for (const coercion of ["yine dene", "tekrar dene", "yapmalısın", "devam etmelisin", "engel yok"]) {
    expect(text.toLowerCase()).not.toContain(coercion);
  }
});

test("the correction is not itself read as a block claim", () => {
  // It has to name the claim to correct it, and the matcher is deliberately broad — broad enough
  // that a careless wording here would register as a fresh claim and read as a loop in the logs.
  for (const counts of [{ completed: 4, failed: 0 }, { completed: 0, failed: 0 }]) {
    expect(claimsBlockedToolCall(falseBlockCorrection(counts))).toBeFalse();
  }
});
