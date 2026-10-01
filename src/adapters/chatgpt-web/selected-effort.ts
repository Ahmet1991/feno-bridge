/** Only complete, unambiguous closed-trigger labels can stand in for opening the slider. */
const EFFORT_LABELS: ReadonlyArray<ReadonlyArray<string>> = [
  ["Instant", "Anında", "即时"],
  ["Medium", "Orta", "中等"],
  ["High", "Yüksek", "高"],
  ["Extra High", "Ekstra Yüksek", "超高"],
  ["Pro"],
];

export function selectedEffortMatches(label: string, targetIndex: number): boolean {
  const clean = label.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  return (EFFORT_LABELS[targetIndex] ?? []).some(value => value.toLocaleLowerCase("en-US") === clean);
}

/**
 * Whether two closed-trigger labels name the same effort. 01.10: a selection read "High" and,
 * after ChatGPT re-rendered the composer with its Turkish strings, the same control read "Yüksek";
 * the pre-send check took that for a lost selection on every image continuation (~5 s each).
 */
export function sameEffortLabel(left: string, right: string): boolean {
  const clean = (label: string) => label.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  if (clean(left) === clean(right)) return true;
  return EFFORT_LABELS.some(labels => {
    const known = labels.map(value => value.toLocaleLowerCase("en-US"));
    return known.includes(clean(left)) && known.includes(clean(right));
  });
}
