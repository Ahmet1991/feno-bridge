import { expect, test } from "bun:test";
import { chatGptWebContextOverflowWarning } from "../src/adapters/chatgpt-web/usage";
import { resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";

test("warns above the effective Codex window while preserving the full model window", () => {
  const limits = resolveChatGptWebContextLimits("gpt-5.6-sol", "medium", {
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: true,
  });
  expect(limits.contextWindow).toBe(270_000);
  expect(chatGptWebContextOverflowWarning(240_300, limits)).toBeUndefined();
  expect(chatGptWebContextOverflowWarning(247_305, limits)).toEqual({
    modelContextWindow: 270_000,
    codexEffectiveContextWindow: 240_300,
    excessTokens: 7_005,
  });
});

test("Codex's 90% clamp applies when the catalog advertises a larger percent", () => {
  expect(chatGptWebContextOverflowWarning(91, {
    contextWindow: 100,
    effectiveContextWindowPercent: 100,
    autoCompactTokenLimit: 100,
  })).toEqual({ modelContextWindow: 100, codexEffectiveContextWindow: 90, excessTokens: 1 });
});
