import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { PcAccessDeniedError, isValidPcRoot } from "./authorization";

const platformPath = process.platform === "win32" ? path.win32 : path.posix;

function canonical(input: string): string {
  try {
    return realpathSync.native(input);
  } catch {
    throw new PcAccessDeniedError();
  }
}

function within(candidate: string, root: string): boolean {
  const actual = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const approved = process.platform === "win32" ? root.toLowerCase() : root;
  const relative = platformPath.relative(approved, actual);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${platformPath.sep}`) && !platformPath.isAbsolute(relative));
}

/**
 * Canonicalize an absolute path after resolving approved existing directory roots.
 * Existing target and each create-target parent must remain within a real root,
 * including across Windows junctions. Caller revalidates before changing bytes.
 */
export function resolveAllowedPath(
  requested: string,
  roots: string[],
  options: { forCreate?: boolean } = {},
): string {
  if (typeof requested !== "string" || requested.length > 4096 || requested.includes("\0")
    || !platformPath.isAbsolute(requested) || !Array.isArray(roots) || roots.length === 0
  ) throw new PcAccessDeniedError();
  const acceptedRoots = roots.map(root => {
    if (!isValidPcRoot(root) || !platformPath.isAbsolute(root)) throw new PcAccessDeniedError();
    const actual = canonical(root);
    try {
      if (!statSync(actual).isDirectory()) throw new PcAccessDeniedError();
    } catch { throw new PcAccessDeniedError(); }
    return actual;
  });

  const normalized = platformPath.normalize(requested);
  let actual: string;
  if (options.forCreate) {
    const parent = canonical(platformPath.dirname(normalized));
    actual = platformPath.join(parent, platformPath.basename(normalized));
    // A pre-existing final symlink is never a valid atomic write target.
    try {
      if (lstatSync(actual).isSymbolicLink()) throw new PcAccessDeniedError();
    } catch (error) {
      if (error instanceof PcAccessDeniedError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PcAccessDeniedError();
    }
  } else {
    actual = canonical(normalized);
  }
  if (!acceptedRoots.some(root => within(actual, root))) throw new PcAccessDeniedError();
  return actual;
}
