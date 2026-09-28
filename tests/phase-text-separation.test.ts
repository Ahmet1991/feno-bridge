import { expect, test } from "bun:test";
import { separatePhaseText } from "../src/adapters/chatgpt-web/index";

test("an image continuation's first text starts a new paragraph after the previous answer", () => {
  // 27 Sep 23:57 UTC, verbatim: "... bu sayıma girmez.Abim, şimdi görüntüler net görünüyor."
  const result = separatePhaseText(["", "Abim, şimdi", " görüntüler net görünüyor."], 1, undefined, "Önceki cevap.");
  expect(result.deltas.join("")).toBe("\n\nAbim, şimdi görüntüler net görünüyor.");
  expect(result.separatedPhase).toBe(1);
});

test("the break is added once per phase, so a phase that resumes after tools is not split again", () => {
  const first = separatePhaseText(["Birinci parça."], 1, undefined, "Önceki cevap.");
  const resumed = separatePhaseText(["İkinci parça."], 1, first.separatedPhase, "Önceki cevap.");
  expect(resumed.deltas).toEqual(["İkinci parça."]);
  const nextPhase = separatePhaseText(["Üçüncü aşama."], 2, resumed.separatedPhase, "İkinci aşamanın cevabı.");
  expect(nextPhase.deltas).toEqual(["\n\nÜçüncü aşama."]);
});

test("the first phase, empty text, an empty previous answer and existing breaks are left alone", () => {
  expect(separatePhaseText(["İlk cevap."], 0, undefined, undefined).deltas).toEqual(["İlk cevap."]);
  const empty = separatePhaseText(["", ""], 1, undefined, "Önceki cevap.");
  expect(empty).toEqual({ deltas: ["", ""], separatedPhase: undefined });
  expect(separatePhaseText(["Metin."], 1, undefined, "  ").deltas).toEqual(["Metin."]);
  expect(separatePhaseText(["\nMetin."], 1, undefined, "Önceki cevap.").deltas).toEqual(["\nMetin."]);
});
