import { expect, test } from "bun:test";
import {
  blockClaimEvidenceFor,
  claimsBlockedToolCall,
  formatBlockClaimEvidence,
} from "../src/adapters/chatgpt-web/block-claim-evidence";

test("a blocked-call claim is recognised in the wordings ChatGPT actually produced", () => {
  const seen = [
    "Bu araç çağrısı, isteğin güvenlik durumunu belirleyemediğimiz için OpenAI tarafından engellendi.",
    "Bu araç OpenAI'ın güvenlik kontrolleri tarafından engellendi. Lütfen gönderdiğin içeriği tekrar kontrol et.",
    "Ekran görüntüsü alma işlemi ise tekrar güvenlik engeline takıldı.",
    "This tool call was blocked by OpenAI's safety checks.",
  ];
  for (const answer of seen) expect(claimsBlockedToolCall(answer)).toBeTrue();
  expect(claimsBlockedToolCall("GitHub Desktop penceresi bulundu ve içeriği okundu.")).toBeFalse();
});

test("the evidence line reports what the bridge dispatched, including the none case", () => {
  expect(formatBlockClaimEvidence({ completed: 6, failed: 0 }))
    .toBe("\n\n---\n[Feno Bridge] Bu turda 6 araç çağrısı tamamlandı, 0 tanesi hata döndürdü.");
  expect(formatBlockClaimEvidence({ completed: 4, failed: 2 }))
    .toContain("4 araç çağrısı tamamlandı, 2 tanesi hata döndürdü");
  expect(formatBlockClaimEvidence({ completed: 0, failed: 0 }))
    .toContain("hiç araç çağrısı yapılmadı");
});

test("only an answer that claims a block carries the evidence line", () => {
  // The session that prompted this: six calls, every one answered, no screenshot ever requested.
  expect(blockClaimEvidenceFor(
    "Pencereyi öne getirme ve ekran görüntüsü alma çağrısı engellendi.",
    { completed: 6, failed: 0 },
  )).toContain("6 araç çağrısı tamamlandı, 0 tanesi hata döndürdü");
  expect(blockClaimEvidenceFor("Üç sekme okundu.", { completed: 6, failed: 0 })).toBeUndefined();
});
