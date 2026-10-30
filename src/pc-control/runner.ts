import { PcAccessDeniedError } from "./authorization";

export type PcRunnerState = "online" | "offline" | "unknown";
export type PcRunnerProbe = () => Promise<{ state: PcRunnerState; activeJob?: string }>;

/** No destructive Actions API call. A trusted launcher may install a read-only runner probe. */
export async function getRunnerStatus(
  options: { label: "fenotip-tv" },
  probe?: PcRunnerProbe,
): Promise<{ state: PcRunnerState; source: string; activeJob?: string }> {
  if (!options || options.label !== "fenotip-tv") throw new PcAccessDeniedError();
  if (!probe) return { state: "unknown", source: "not-configured" };
  try {
    const result = await probe();
    if (!["online", "offline", "unknown"].includes(result.state)) throw new Error("invalid probe result");
    const activeJob = result.activeJob && /^[a-zA-Z0-9_. -]{1,100}$/.test(result.activeJob)
      ? result.activeJob : undefined;
    return { state: result.state, source: "configured-probe", ...(activeJob ? { activeJob } : {}) };
  } catch {
    return { state: "unknown", source: "probe-error" };
  }
}
