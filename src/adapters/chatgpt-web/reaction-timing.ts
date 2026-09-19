/** One accepted browser submission produces exactly one compact, machine-readable latency line. */
export function formatBrowserTurnReactionLog(sample: {
  traceId: string;
  elapsedMs: number;
  reused: boolean;
  multipartParts?: number;
  stages: ReadonlyMap<string, number>;
}): string {
  const duration = (ms: number): number => Math.max(0, Math.round(ms));
  const stages = [...sample.stages].map(([name, ms]) => `${name}:${duration(ms)}`).join(",");
  const transport = sample.multipartParts === undefined ? "inline" : `multipart-${sample.multipartParts}`;
  return `[chatgpt-web] browser turn ${sample.traceId} reaction ms=${duration(sample.elapsedMs)}`
    + ` conversation=${sample.reused ? "reused" : "new"} transport=${transport} stages=${stages}`;
}
