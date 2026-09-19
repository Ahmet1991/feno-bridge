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
