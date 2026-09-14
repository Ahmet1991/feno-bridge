import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RuntimeBuildStamp {
  commit: string;
  dirty: boolean;
  builtAt: string;
}

/** The bundle places this module under <root>/app and the manifest at <root>/manifest.json. */
export function defaultManifestPath(): string {
  return join(dirname(import.meta.dir), "manifest.json");
}

/**
 * Reads the stamp out of manifest text.
 *
 * Every field is checked rather than trusted: this runs against a file on the user's disk, and a
 * manifest written by an older bundler has no `build` key at all.
 */
export function parseRuntimeBuildStamp(raw: string): RuntimeBuildStamp | undefined {
  let build: Partial<RuntimeBuildStamp> | undefined;
  try {
    build = (JSON.parse(raw) as { build?: Partial<RuntimeBuildStamp> }).build;
  } catch {
    return undefined;
  }
  if (!build
    || typeof build.commit !== "string"
    || typeof build.dirty !== "boolean"
    || typeof build.builtAt !== "string") return undefined;
  return { commit: build.commit, dirty: build.dirty, builtAt: build.builtAt };
}

/**
 * The tree an installed runtime was built from.
 *
 * VERSION is deliberately never bumped in this fork, so it cannot distinguish one build from
 * another. `scripts/build-runtime-bundle.ts` records the commit in the bundle manifest instead.
 *
 * Absent by design when running from source, and absent for any bundle built before the stamp
 * existed, so every caller must handle `undefined` rather than treat it as a failure.
 */
export function runtimeBuildStamp(manifestPath = defaultManifestPath()): RuntimeBuildStamp | undefined {
  try {
    return parseRuntimeBuildStamp(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
}

/** One line naming the build, or the reason there is nothing to name. */
export function formatRuntimeBuildStamp(stamp = runtimeBuildStamp()): string {
  if (!stamp) return "build stamp is unavailable (running from source, or a bundle built before stamping)";
  return `built from ${stamp.commit}${stamp.dirty ? " (dirty tree)" : ""} at ${stamp.builtAt}`;
}
