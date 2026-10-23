/** Only complete, unambiguous closed-trigger labels can stand in for opening the slider. */
const EFFORT_LABELS: ReadonlyArray<ReadonlyArray<string>> = [
  ["Instant", "Anında", "即时"],
  ["Medium", "Orta", "中等"],
  ["High", "Yüksek", "高"],
  ["Extra High", "Ekstra Yüksek", "超高"],
  ["Pro"],
];

const VERSION_PREFIX = /^(?:gpt[- ]?)?\d+(?:\.\d+)?\s+(?=\S)/i;

function knownEffort(value: string): boolean {
  return EFFORT_LABELS.some(labels => labels.some(label => label.toLocaleLowerCase("en-US") === value));
}

/**
 * The effort part of a closed-trigger label. 21.10: with GPT-6 the trigger names the model before
 * the effort ("6 Yüksek", "6 High"), so no label matched and every turn opened the effort menu
 * again, about three seconds per message; a leading version number is dropped. 24.10: the trigger
 * also shows its caption on a line of its own ("Akıl yürütme düzeyi" / "6 High"). The last line
 * names the effort only when no other line does; two effort words stay ambiguous.
 */
function effortPart(label: string): string {
  const lines = label.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const efforts = lines.map(line => line.replace(VERSION_PREFIX, "").toLocaleLowerCase("en-US"));
  const last = efforts.at(-1) ?? "";
  if (efforts.length > 1 && knownEffort(last) && efforts.filter(knownEffort).length === 1) return last;
  return lines.join(" ").replace(VERSION_PREFIX, "").toLocaleLowerCase("en-US");
}

/**
 * 24.10: the closed trigger carries the selected effort as data-selected-reasoning-effort ("high"
 * measured live), which no translation or caption changes. Only values seen or documented count.
 */
const EFFORT_ATTRIBUTE_VALUES: ReadonlyArray<ReadonlyArray<string>> = [
  [],
  ["medium"],
  ["high"],
  ["xhigh", "extra_high", "extra-high"],
  [],
];

export function selectedEffortAttributeMatches(value: string | null | undefined, targetIndex: number): boolean {
  const clean = value?.trim().toLowerCase();
  return Boolean(clean) && (EFFORT_ATTRIBUTE_VALUES[targetIndex] ?? []).includes(clean!);
}

export function selectedEffortMatches(label: string, targetIndex: number): boolean {
  const clean = effortPart(label);
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
    return known.includes(effortPart(left)) && known.includes(effortPart(right));
  });
}
