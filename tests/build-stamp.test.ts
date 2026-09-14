import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatRuntimeBuildStamp,
  parseRuntimeBuildStamp,
  runtimeBuildStamp,
} from "../src/build-stamp";

function manifest(build: unknown): string {
  return JSON.stringify({ schemaVersion: 2, entrypoint: "app/cli.js", build });
}

test("a complete stamp survives the round trip through the manifest", () => {
  const stamp = parseRuntimeBuildStamp(
    manifest({ commit: "c22b6a410577", dirty: false, builtAt: "2026-09-14T20:54:34.624Z" }),
  );
  expect(stamp).toEqual({ commit: "c22b6a410577", dirty: false, builtAt: "2026-09-14T20:54:34.624Z" });
});

test("a manifest from a bundle built before stamping reads as unstamped, not as an error", () => {
  expect(parseRuntimeBuildStamp(manifest(undefined))).toBeUndefined();
});

// Every one of these is a file on the user's disk that we do not control. A throw here would take
// down `doctor`, which is the one command they run when everything else is already broken.
test.each([
  ["not JSON at all", "{{{"],
  ["an empty file", ""],
  ["a manifest that is not an object", "42"],
  ["a null build", manifest(null)],
  ["a build that is a string", manifest("c22b6a4")],
  ["a missing commit", manifest({ dirty: false, builtAt: "2026-09-14T20:54:34.624Z" })],
  ["a missing builtAt", manifest({ commit: "c22b6a410577", dirty: false })],
  ["a dirty flag that is a string", manifest({ commit: "c22b6a4", dirty: "false", builtAt: "x" })],
])("%s yields no stamp rather than throwing", (_label, raw) => {
  expect(parseRuntimeBuildStamp(raw)).toBeUndefined();
});

test("a manifest that is not there yields no stamp", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "build-stamp-")), "manifest.json");
  expect(runtimeBuildStamp(missing)).toBeUndefined();
});

test("a manifest that is there is read from disk", () => {
  const path = join(mkdtempSync(join(tmpdir(), "build-stamp-")), "manifest.json");
  writeFileSync(path, manifest({ commit: "abcdef123456", dirty: true, builtAt: "2026-01-02T03:04:05.000Z" }));
  expect(runtimeBuildStamp(path)).toEqual({
    commit: "abcdef123456",
    dirty: true,
    builtAt: "2026-01-02T03:04:05.000Z",
  });
});

test("running from source says so instead of naming a build it cannot see", () => {
  expect(formatRuntimeBuildStamp(undefined)).toBe(
    "build stamp is unavailable (running from source, or a bundle built before stamping)",
  );
});

test("a clean build is named without qualification", () => {
  expect(formatRuntimeBuildStamp({ commit: "c22b6a410577", dirty: false, builtAt: "2026-09-14T20:54:34.624Z" }))
    .toBe("built from c22b6a410577 at 2026-09-14T20:54:34.624Z");
});

// A stamp that names a commit the build does not match is worse than no stamp, so the mismatch is
// reported rather than hidden.
test("a build from a dirty tree admits the tree was dirty", () => {
  expect(formatRuntimeBuildStamp({ commit: "c22b6a410577", dirty: true, builtAt: "2026-09-14T20:54:34.624Z" }))
    .toBe("built from c22b6a410577 (dirty tree) at 2026-09-14T20:54:34.624Z");
});
