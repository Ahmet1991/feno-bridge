import { expect, test } from "bun:test";
import { selectedEffortMatches } from "../src/adapters/chatgpt-web/selected-effort";

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
