import { expect, test } from "bun:test";
import { sameEffortLabel, selectedEffortAttributeMatches, selectedEffortMatches } from "../src/adapters/chatgpt-web/selected-effort";

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

test("a GPT-6 closed label names the model before the effort (21.10)", () => {
  // Measured in DEV: the trigger reads "6 Yüksek"; without this every turn reopened the menu.
  expect(selectedEffortMatches("6 Yüksek", 2)).toBeTrue();
  expect(selectedEffortMatches("6\nHigh", 2)).toBeTrue();
  expect(selectedEffortMatches("6.1 Orta", 1)).toBeTrue();
  expect(selectedEffortMatches("GPT-6 Ekstra Yüksek", 3)).toBeTrue();
  expect(selectedEffortMatches("6 Yüksek", 3)).toBeFalse();
  expect(selectedEffortMatches("6 Ekstra Yüksek", 2)).toBeFalse();
  expect(selectedEffortMatches("6", 2)).toBeFalse();
  expect(selectedEffortMatches("6 Yüksek Pro", 2)).toBeFalse();
  expect(sameEffortLabel("6 Yüksek", "High")).toBeTrue();
  expect(sameEffortLabel("6 Yüksek", "6 Orta")).toBeFalse();
});

test("a closed trigger with its caption on its own line still names the effort (24.10)", () => {
  // Measured in DEV: innerText reads "Akıl yürütme düzeyi\n6 High".
  expect(selectedEffortMatches("Akıl yürütme düzeyi\n6 High", 2)).toBeTrue();
  expect(selectedEffortMatches("Reasoning level\n6 Medium", 1)).toBeTrue();
  expect(selectedEffortMatches("Akıl yürütme düzeyi\n6 High", 3)).toBeFalse();
  expect(selectedEffortMatches("Akıl yürütme düzeyi\n6 Ekstra Yüksek", 3)).toBeTrue();
  // Two effort words remain ambiguous, whatever their order.
  expect(selectedEffortMatches("Yüksek\nPro", 4)).toBeFalse();
  expect(selectedEffortMatches("Pro\n6 High", 2)).toBeFalse();
  expect(sameEffortLabel("Akıl yürütme düzeyi\n6 High", "6 Yüksek")).toBeTrue();
});

test("the selected-effort attribute names the effort without reading any label (24.10)", () => {
  expect(selectedEffortAttributeMatches("high", 2)).toBeTrue();
  expect(selectedEffortAttributeMatches(" HIGH ", 2)).toBeTrue();
  expect(selectedEffortAttributeMatches("medium", 1)).toBeTrue();
  expect(selectedEffortAttributeMatches("xhigh", 3)).toBeTrue();
  expect(selectedEffortAttributeMatches("high", 3)).toBeFalse();
  expect(selectedEffortAttributeMatches("medium", 2)).toBeFalse();
  expect(selectedEffortAttributeMatches(null, 2)).toBeFalse();
  expect(selectedEffortAttributeMatches("", 2)).toBeFalse();
  // Values never observed do not skip the menu.
  expect(selectedEffortAttributeMatches("pro", 4)).toBeFalse();
});
