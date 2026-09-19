import { expect, test } from "bun:test";
import { CHATGPT_PERSONALIZATION_PROOF_TTL_MS, ChatGptPersonalizationProofCache } from "../src/adapters/chatgpt-web/personalization-proof-cache";

test("personalization proof lasts 15 minutes only on the original page and session", () => {
  const cache = new ChatGptPersonalizationProofCache();
  const page = {};
  cache.remember(page, "account-A", 1000);
  expect(cache.isValid(page, "account-A", 1000 + CHATGPT_PERSONALIZATION_PROOF_TTL_MS - 1)).toBeTrue();
  expect(cache.isValid(page, "account-A", 1000 + CHATGPT_PERSONALIZATION_PROOF_TTL_MS)).toBeFalse();
  cache.remember(page, "account-A", 2000);
  expect(cache.isValid({}, "account-A", 2001)).toBeFalse(); // tab recreated
  expect(cache.isValid(page, "account-B", 2001)).toBeFalse(); // account changed
  expect(cache.isValid(page, "account-A", 2001)).toBeFalse(); // old proof invalidated
  cache.remember(page, "account-A", 3000);
  expect(cache.isValid(page, undefined, 3001)).toBeFalse(); // session unavailable
  cache.remember(page, "account-A", 4000);
  cache.invalidate(page); // connector/menu or personalization error
  expect(cache.isValid(page, "account-A", 4001)).toBeFalse();
});
