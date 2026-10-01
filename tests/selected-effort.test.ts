import { expect, test } from "bun:test";
import { sameEffortLabel, selectedEffortMatches } from "../src/adapters/chatgpt-web/selected-effort";

test("only complete, unambiguous English/Turkish/Chinese closed labels can skip effort selection", () => {
  expect(selectedEffortMatches("High", 2)).toBeTrue();
  expect(selectedEffortMatches("Yüksek", 2)).toBeTrue();
  expect(selectedEffortMatches("高", 2)).toBeTrue();
  expect(selectedEffortMatches("Medium", 2)).toBeFalse();
  expect(selectedEffortMatches("Extra High", 2)).toBeFalse();
  expect(selectedEffortMatches("Thinking effort", 2)).toBeFalse();
  expect(selectedEffortMatches("Yüksek\nPro", 2)).toBeFalse();
  expect(selectedEffortMatches("未知", 2)).toBeFalse();
  expect(selectedEffortMatches("Pro", 4)).toBeTrue();
});

test("one effort read in two languages is the same selection (01.10)", () => {
  // After a re-render the trigger read "Yüksek" where the selection had recorded "High".
  expect(sameEffortLabel("Yüksek", "High")).toBeTrue();
  expect(sameEffortLabel("High", "  high ")).toBeTrue();
  expect(sameEffortLabel("Ekstra Yüksek", "Extra High")).toBeTrue();
  expect(sameEffortLabel("Yüksek", "Extra High")).toBeFalse();
  expect(sameEffortLabel("Orta", "High")).toBeFalse();
  expect(sameEffortLabel("Thinking effort", "High")).toBeFalse();
});
