import { expect, test } from "bun:test";
import { looksAlteredInTransit, withinOneEdit } from "../src/adapters/chatgpt-web/turn-broker";

// The live signature this was written for: on 21 Sep a claim arrived with 36 characters where every
// accepted claim has 37, the same value three times in one turn.
const LIVE = "turn_0123456789abcdef0123456789abcdef";

test("a token that lost one character is recognised as the live one", () => {
  expect(LIVE).toHaveLength(37);
  for (const cut of [0, 5, 20, LIVE.length - 1]) {
    expect(withinOneEdit(LIVE.slice(0, cut) + LIVE.slice(cut + 1), LIVE)).toBeTrue();
  }
});

test("one substitution or one insertion also counts", () => {
  expect(withinOneEdit(`${LIVE.slice(0, 10)}X${LIVE.slice(11)}`, LIVE)).toBeTrue();
  expect(withinOneEdit(`${LIVE.slice(0, 10)}X${LIVE.slice(10)}`, LIVE)).toBeTrue();
  expect(withinOneEdit(LIVE, LIVE)).toBeTrue();
});

test("two edits do not count, or the measurement would call every stale token mangled", () => {
  expect(withinOneEdit(LIVE.slice(0, 35), LIVE)).toBeFalse();
  expect(withinOneEdit(`${LIVE.slice(0, 10)}XY${LIVE.slice(12)}`, LIVE)).toBeFalse();
  expect(withinOneEdit("turn_ffffffffffffffffffffffffffffffff", LIVE)).toBeFalse();
  expect(withinOneEdit("", LIVE)).toBeFalse();
});

test("the generated token carries nothing Markdown can eat", async () => {
  // The whole point of the hex change: `_` and `-` are Markdown's emphasis characters, and this id
  // is rendered as Markdown before the model reads it back. The one underscore is the prefix
  // separator, which sits between two alphanumerics and cannot open emphasis on its own.
  const { TurnBroker } = await import("../src/adapters/chatgpt-web/turn-broker");
  const broker = TurnBroker.forSocket(`\\\\.\\pipe\\codex-token-shape-${process.pid}-${Date.now()}`);
  try {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const token = await broker.register({ tools: [], instructions: "" } as never, 1_000, "trace");
      seen.add(token);
      expect(token).toMatch(/^turn_[0-9a-f]{32}$/);
      expect(token).toHaveLength(37);
    }
    expect(seen.size).toBe(50);
  } finally {
    await broker.close();
  }
});

test("a verbatim token is stale, not altered; a one-character loss is altered", () => {
  // The figure exists to separate a token the surface changed from one that is merely late, so a
  // verbatim claim has to fall on the stale side even though `withinOneEdit` accepts it.
  expect(withinOneEdit(LIVE, LIVE)).toBeTrue();
  expect(looksAlteredInTransit(LIVE, LIVE)).toBeFalse();
  expect(looksAlteredInTransit(LIVE.slice(0, 20) + LIVE.slice(21), LIVE)).toBeTrue();
  expect(looksAlteredInTransit("turn_ffffffffffffffffffffffffffffffff", LIVE)).toBeFalse();
});
