import { expect, test } from "bun:test";
import {
  blockClaimEvidenceFor,
  claimsBlockedToolCall,
  formatBlockClaimEvidence,
  TurnCallLedger,
} from "../src/adapters/chatgpt-web/block-claim-evidence";
import { skyFunctionsIn } from "../src/adapters/chatgpt-web/window-recovery";

test("the window functions a dispatched call asked for are read from the call itself", () => {
  const call = {
    callId: "call_1",
    wireName: "js",
    freeform: false,
    arguments: {
      code: "globalThis.windows = await sky.list_windows(); const w = await sky.get_window({id:589952});",
    },
  };
  expect(skyFunctionsIn(call).sort()).toEqual(["get_window", "list_windows"]);
  // A shell command that merely mentions the name is not a call.
  expect(skyFunctionsIn({
    callId: "call_2",
    wireName: "exec_command",
    freeform: false,
    arguments: { cmd: "rg -n 'sky.get_window_state(' docs" },
  })).toEqual([]);
});

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

test("the ledger counts a whole turn, not the round the answer landed in", () => {
  // 20 Sep: two js calls went out in separate rounds and the line reported one. A Codex turn spans
  // several adapter rounds, so the ledger has to survive them.
  const ledger = new TurnCallLedger();
  ledger.record(["list_windows"], false);
  ledger.record(["get_window"], false);
  expect(ledger.completed).toBe(2);
  expect(ledger.failed).toBe(0);
  expect(formatBlockClaimEvidence(ledger.summary())).toContain("2 araç çağrısı tamamlandı");
});

test("a turn that set a window up but never asked to capture it is reported as such", () => {
  // The 15:38 turn exactly: the window was found and its handle fetched, the screenshot call never
  // arrived, and the answer blamed a block.
  const ledger = new TurnCallLedger();
  ledger.record(["list_windows"], false);
  ledger.record(["get_window"], false);
  expect(ledger.summary().windowCaptureNeverReached).toBeTrue();

  const line = formatBlockClaimEvidence(ledger.summary());
  expect(line).toContain("get_window_state");
  // It states reach, never intent: a call suppressed above the bridge never arrives either.
  expect(line).toContain("köprüye hiç ulaşmadı");
});

test("a turn that did capture the window says nothing about a missing call", () => {
  const ledger = new TurnCallLedger();
  ledger.record(["list_windows"], false);
  ledger.record(["get_window", "activate_window", "get_window_state"], false);
  expect(ledger.summary().windowCaptureNeverReached).toBeFalse();
  expect(formatBlockClaimEvidence(ledger.summary())).not.toContain("get_window_state");
});

test("a turn that never touched a window is not described as missing a screenshot", () => {
  const ledger = new TurnCallLedger();
  ledger.record([], false);
  ledger.record(["read_file"], true);
  expect(ledger.summary().windowCaptureNeverReached).toBeFalse();
  expect(ledger.failed).toBe(1);
});

test("only an answer that claims a block carries the evidence line", () => {
  // The session that prompted this: six calls, every one answered, no screenshot ever requested.
  expect(blockClaimEvidenceFor(
    "Pencereyi öne getirme ve ekran görüntüsü alma çağrısı engellendi.",
    { completed: 6, failed: 0 },
  )).toContain("6 araç çağrısı tamamlandı, 0 tanesi hata döndürdü");
  expect(blockClaimEvidenceFor("Üç sekme okundu.", { completed: 6, failed: 0 })).toBeUndefined();
});


test("an answer that says the tools are not there is a block claim too", () => {
  // Both sentences are verbatim from 22 Sep. The request the bridge received for those same turns
  // declared exec_command, write_stdin, apply_patch and view_image, so the claim was false -- and
  // the detector stayed silent, which is why the correction never ran.
  for (const answer of [
    "Adim 2, 3 ve 4 icin gerekli yerel Codex Native araclari bu oturumda kullanilabilir olarak"
      + " gorunmuyor; bu nedenle islemleri calistirip sonuc uretemiyorum.",
    "`exec_command` araci bu oturumda kullanilabilir degil; bu nedenle komutu calistiramadim.",
    "Adım 2, 3 ve 4 için gerekli yerel Codex Native araçları bu oturumda kullanılabilir olarak"
      + " görünmüyor; bu nedenle işlemleri çalıştırıp sonuç üretemiyorum.",
    "`exec_command` aracı bu oturumda kullanılabilir değil; bu nedenle komutu çalıştıramadım.",
    "The exec_command tool is not available in this session, so I could not run it.",
  ]) {
    expect(claimsBlockedToolCall(answer)).toBeTrue();
  }
});

test("an unavailable thing that is not a tool is not a block claim", () => {
  // The line costs the user attention, so it must not fire on an answer that is simply reporting.
  for (const answer of [
    "Dosya mevcut degil, bu yuzden olusturdum.",
    "The staging server is not available right now, so I used the local build.",
    "Bu klasore erisilemiyor; izinleri kontrol eder misin?",
    "exec_command ile calistirdim ve cikti basariliydi.",
    "Araclari kullanarak dort adimi da tamamladim.",
  ]) {
    expect(claimsBlockedToolCall(answer)).toBeFalse();
  }
});
