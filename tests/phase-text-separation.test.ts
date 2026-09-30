import { expect, test } from "bun:test";
import { passContinuationText, separatePhaseText } from "../src/adapters/chatgpt-web/index";

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

test("a continuation that only repeats the previous answer is held and never sent (30 Sep)", () => {
  // 30.09 22:58: after the images of a finished round the model wrote its 653-character answer again.
  const answer = "## ADIM 1\n\nTUR-2-BASLADI\n\n## ADIM 20\n\nTUR-2-BITTI";
  let state = passContinuationText(undefined, ["## ADIM 1\n\nTUR-2-"], 1, answer);
  expect(state.deltas).toEqual([]);
  state = passContinuationText(state.echo, ["BASLADI\n\n## ADIM 20\n\nTUR-2-BITTI"], 1, answer);
  expect(state.deltas).toEqual([]);
  expect(state.echo?.held.join("")).toBe(answer);
});

test("a continuation that says something else is released whole, and a repeat that goes on sends only the new part", () => {
  const answer = "Sonuç: 144";
  let state = passContinuationText(undefined, ["Sonuç"], 1, answer);
  expect(state.deltas).toEqual([]);
  state = passContinuationText(state.echo, [" düzeltildi: 145"], 1, answer);
  expect(state.deltas).toEqual(["Sonuç", " düzeltildi: 145"]);
  expect(passContinuationText(state.echo, [" devam"], 1, answer).deltas).toEqual([" devam"]);

  let repeat = passContinuationText(undefined, ["Sonuç: 144"], 1, answer);
  expect(repeat.deltas).toEqual([]);
  repeat = passContinuationText(repeat.echo, ["\n\nGörüntü bunu doğruluyor."], 1, answer);
  expect(repeat.deltas).toEqual(["\n\nGörüntü bunu doğruluyor."]);
});

test("the first phase and a phase after an empty answer pass their text straight through", () => {
  expect(passContinuationText(undefined, ["Sonuç: 144"], 0, "Sonuç: 144").deltas).toEqual(["Sonuç: 144"]);
  expect(passContinuationText(undefined, ["Metin."], 1, "  ").deltas).toEqual(["Metin."]);
  // A new phase starts its own check even if the previous phase was released.
  const released = passContinuationText(undefined, ["Başka"], 1, "Önceki").echo;
  expect(passContinuationText(released, ["Önce"], 2, "Önceki").deltas).toEqual([]);
});
