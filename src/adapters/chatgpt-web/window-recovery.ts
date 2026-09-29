/**
 * `sky.get_window_state` will not capture a minimized window. It returns a sentence telling the
 * caller what to do first, and the model often reads that sentence as a refusal, answers that the
 * call was blocked, and never takes the screenshot. See docs/minimized-window-recovery.md for the
 * counts this was built from.
 *
 * The call itself succeeds, so nothing here looks at an error flag or moves the turn's call ledger:
 * the trigger is a result that needs recovery, not a failed call.
 */
import type { BrokerToolRequest } from "./turn-broker";
import type { CodexContentPart, CodexToolResultMessage } from "../../types";

/** Returned as ordinary output by the @oai/sky runtime, not by any file in the installed plugin. */
const MINIMIZED_GUIDANCE =
  "window is minimized; call activate_window, refresh with get_window, then retry get_window_state";

/**
 * The tool ending the turn itself. This outranks recovery: the bridge stands down rather than
 * pushing a model past a real stop.
 */
const POLICY_STOP =
  "Computer Use has been stopped for this turn because it could not determine the current browser URL on Windows"
  + " with enough confidence to enforce policy. Stop your work and send a final message noting why Computer Use ended.";

/** Only a call that asked to observe a window can produce a result worth recovering. */
const OBSERVATION_CALL = /get_window_state/;
const JAVASCRIPT_TOOL = /(?:^|__)js$/;

/** A live result is a couple of hundred characters; a quoted one arrives inside a whole document. */
const MAX_DIRECT_RESULT_CHARS = 2_000;

export function toolResultText(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  return content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

export function toolResultHasImage(content: string | CodexContentPart[]): boolean {
  if (typeof content === "string") return false;
  return content.some(part => part.type === "image");
}

/** Drops the `Wall time: …` / `Output:` header the JS tool prints above every result. */
export function strippedResultText(text: string): string {
  return text
    .split("\n")
    .filter(line => !/^Wall time:/.test(line.trim()) && line.trim() !== "Output:")
    .join("\n")
    .trim();
}

export function isPolicyStop(text: string): boolean {
  const stripped = strippedResultText(text).replace(/^Error:\s*/, "").replace(/\s+/g, " ");
  return stripped === POLICY_STOP;
}

/**
 * True only when the guidance *is* the result. A document that merely contains the sentence — a
 * transcript the model was reading, this repository's own documentation — must not trigger anything.
 */
export function isMinimizedGuidance(text: string): boolean {
  const stripped = strippedResultText(text).replace(/^Error:\s*/, "");
  return stripped === MINIMIZED_GUIDANCE;
}

/**
 * The snippet a call carries, read from the argument values themselves. Serialising the arguments
 * instead would double every backslash, and window paths are full Windows paths.
 */
function callSource(call: BrokerToolRequest): string {
  if (call.input !== undefined) return call.input;
  const values = Object.values(call.arguments ?? {});
  return values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
}

export function callObservesWindow(call: BrokerToolRequest | undefined): boolean {
  if (!call) return false;
  return JAVASCRIPT_TOOL.test(call.wireName) && OBSERVATION_CALL.test(callSource(call));
}

/**
 * The window a call names, used to bind a later image back to this recovery. Windows are selected
 * inside a JS snippet rather than through structured arguments, so this reads the snippet. A call
 * that selects through a variable yields no target; recovery still runs, but success stays unbound.
 */
export function windowTargetOf(call: BrokerToolRequest | undefined): string | undefined {
  if (!call) return undefined;
  const source = callSource(call);
  const id = /\bid\\?["']?\s*:\s*(\d+)/.exec(source);
  if (!id) return undefined;
  // Window paths are full Windows paths, so the value keeps its backslashes and only ends at the
  // closing quote: `app: 'process:C:\\Windows\\explorer.exe'`.
  const app = /\bapp\\?["']?\s*:\s*\\?["'`]((?:\\.|[^"'`\\])*)/.exec(source);
  return app ? `${app[1]}#${id[1]}` : `#${id[1]}`;
}

export function recoveryNote(target: string | undefined): string {
  const window = target ? ` for ${target}` : "";
  return `[Feno Bridge] The line above is guidance from the window API, not a refusal and not a`
    + ` block: the call succeeded. Finish the step you were asked to do${window} —`
    + ` sky.activate_window({ window }), re-fetch the handle with sky.get_window(...), then retry`
    + ` sky.get_window_state({ window, include_screenshot: true }). Do not end the turn reporting`
    + ` this as blocked.`;
}

export type RecoveryOutcome =
  | { kind: "recover"; note: string; target: string | undefined }
  | { kind: "succeeded"; target: string }
  | { kind: "stand_down" }
  | { kind: "near_miss"; text: string }
  | undefined;

/**
 * Per-turn state. One recovery per turn, and a pending recovery is dropped the moment a policy stop
 * appears or the bound target comes back with an image.
 */
export class WindowRecoveryTracker {
  private used = false;
  private stopped = false;
  private pendingTarget: string | undefined;
  private pending = false;

  standDown(): RecoveryOutcome {
    if (this.stopped) return undefined;
    this.stopped = true;
    this.pending = false;
    this.pendingTarget = undefined;
    return { kind: "stand_down" };
  }

  inspect(call: BrokerToolRequest | undefined, message: CodexToolResultMessage): RecoveryOutcome {
    if (this.stopped) return undefined;
    const text = toolResultText(message.content);
    if (callObservesWindow(call) && isPolicyStop(text)) return this.standDown();
    // Success is an image returned by observing the window the recovery was about, not any image
    // that happens to arrive later in the turn.
    if (this.pending && toolResultHasImage(message.content) && callObservesWindow(call)) {
      const target = windowTargetOf(call);
      if (target !== undefined && target === this.pendingTarget) {
        this.pending = false;
        this.pendingTarget = undefined;
        return { kind: "succeeded", target };
      }
    }
    if (!callObservesWindow(call)) return undefined;
    if (isMinimizedGuidance(text)) {
      if (this.used) return undefined;
      this.used = true;
      this.pending = true;
      this.pendingTarget = windowTargetOf(call);
      return { kind: "recover", note: recoveryNote(this.pendingTarget), target: this.pendingTarget };
    }
    // The sentence comes from the sky runtime and cannot be version-checked against the installed
    // plugin, so a reworded release would silently stop matching. Report the shape instead.
    if (!toolResultHasImage(message.content) && text.length <= MAX_DIRECT_RESULT_CHARS) {
      return { kind: "near_miss", text: strippedResultText(text) };
    }
    return undefined;
  }
}
