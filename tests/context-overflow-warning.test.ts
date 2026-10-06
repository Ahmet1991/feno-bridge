import { expect, test } from "bun:test";
import { chatGptWebContextOverflowWarning } from "../src/adapters/chatgpt-web/usage";
import { resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";

test("warns above the effective Codex window while preserving the full model window", () => {
  const limits = resolveChatGptWebContextLimits("gpt-5.6-sol", "medium", {
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: true,
  });
  expect(limits.contextWindow).toBe(119_808);
  expect(chatGptWebContextOverflowWarning(105_431, limits)).toBeUndefined();
  expect(chatGptWebContextOverflowWarning(110_000, limits)).toEqual({
    modelContextWindow: 119_808,
    codexEffectiveContextWindow: 105_431,
    excessTokens: 4_569,
  });
});

test("Bigger Context on Plus compacts inside ChatGPT's 128K reasoning input window", () => {
  // 07.10: past that window ChatGPT silently dropped the oldest context, Codex's AGENTS.md included.
  const plus = { solAvailable: true, proAvailable: false, extraHighAvailable: true };
  for (const effort of ["medium", "high", "xhigh"] as const) {
    expect(resolveChatGptWebContextLimits("gpt-5.6-sol", effort, { ...plus, experimentalBiggerContext: true })).toEqual({
      contextWindow: 119_808,
      effectiveContextWindowPercent: 88,
      autoCompactTokenLimit: 105_000,
    });
  }
  // Instant's window is all the model sees, so Bigger Context leaves it as it is.
  expect(resolveChatGptWebContextLimits("gpt-5.6-sol", "low", { ...plus, experimentalBiggerContext: true }))
    .toEqual(resolveChatGptWebContextLimits("gpt-5.6-sol", "low", { ...plus, experimentalBiggerContext: false }));
  // Pro keeps three standard windows; its reasoning input window was not measured.
  const pro = { solAvailable: true, proAvailable: true, extraHighAvailable: true };
  const proStandard = resolveChatGptWebContextLimits("gpt-5.6-sol", "medium", { ...pro, experimentalBiggerContext: false });
  const proBigger = resolveChatGptWebContextLimits("gpt-5.6-sol", "medium", { ...pro, experimentalBiggerContext: true });
  expect(proBigger.contextWindow).toBe(proStandard.contextWindow * 3);
  expect(proBigger.autoCompactTokenLimit).toBe(proStandard.autoCompactTokenLimit * 3);
});

test("Codex's 90% clamp applies when the catalog advertises a larger percent", () => {
  expect(chatGptWebContextOverflowWarning(91, {
    contextWindow: 100,
    effectiveContextWindowPercent: 100,
    autoCompactTokenLimit: 100,
  })).toEqual({ modelContextWindow: 100, codexEffectiveContextWindow: 90, excessTokens: 1 });
});
